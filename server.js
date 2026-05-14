/* =====================================================================
 *  AnonChat - Serveur principal
 *  ---------------------------------------------------------------------
 *  Stack : Node.js + Express + Socket.io + Mongoose (MongoDB Atlas)
 *  Auteur : AnonChat Team
 *  Description :
 *    Serveur HTTP + WebSocket gérant l'authentification (inscription /
 *    connexion), la persistance des messages dans MongoDB et la
 *    diffusion temps réel des messages entre clients connectés.
 *
 *  Déploiement :
 *    - Render.com : Build Command  -> npm install
 *                   Start Command  -> npm start
 *    - Variable d'env optionnelle  -> MONGO_URI (sinon fallback ci-dessous)
 * ===================================================================== */

require('dotenv').config();

const express  = require('express');
const http     = require('http');
const path     = require('path');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

/* ---------------------------------------------------------------------
 *  Configuration générale
 * ------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://ambroiserossary_db_user:Azqswx1234@cluster0.hbmqsht.mongodb.net/AnonChat?retryWrites=true&w=majority';

const ADMIN_TRIGGER = '/admin';   // Saisie spéciale dans le champ "Pseudo"
const ADMIN_CODE    = '2Gt5';     // Code C.A requis pour valider l'admin

/* ---------------------------------------------------------------------
 *  Connexion MongoDB Atlas
 * ------------------------------------------------------------------- */
mongoose.connect(MONGO_URI)
  .then(() => console.log('[MongoDB] Connecté à AnonChat ✔'))
  .catch(err => console.error('[MongoDB] Erreur de connexion ✖', err.message));

/* ---------------------------------------------------------------------
 *  Schémas Mongoose
 * ------------------------------------------------------------------- */
const UserSchema = new mongoose.Schema({
  prenom:    { type: String, required: true, trim: true },
  nom:       { type: String, required: true, trim: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  pseudo:    { type: String, required: true, unique: true, trim: true },
  password:  { type: String, required: true },              // ⚠️ démo : non hashé
  role:      { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt: { type: Date, default: Date.now }
});

const MessageSchema = new mongoose.Schema({
  auteur:  { type: String, required: true },
  role:    { type: String, enum: ['user', 'admin'], default: 'user' },
  texte:   { type: String, required: true },
  salon:   { type: String, default: 'general' },
  date:    { type: Date, default: Date.now }
});

const User    = mongoose.model('User', UserSchema);
const Message = mongoose.model('Message', MessageSchema);

/* ---------------------------------------------------------------------
 *  Express + Middlewares
 * ------------------------------------------------------------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------------
 *  Routes API
 * ------------------------------------------------------------------- */

/**
 * POST /api/register
 * Inscription d'un nouvel utilisateur.
 * Gestion du Protocole Admin Invisible :
 *   - Si pseudo === "/admin" ET code C.A === "2Gt5"
 *     => rôle = admin, pseudo => "Admin_<Prenom>"
 */
app.post('/api/register', async (req, res) => {
  try {
    let { prenom, nom, email, pseudo, password, ca } = req.body;

    if (!prenom || !nom || !email || !pseudo || !password) {
      return res.status(400).json({ ok: false, error: 'Tous les champs sont requis.' });
    }

    let role = 'user';

    if (pseudo.trim() === ADMIN_TRIGGER) {
      if (!ca || ca !== ADMIN_CODE) {
        return res.status(403).json({ ok: false, error: 'Code C.A invalide.' });
      }
      role   = 'admin';
      pseudo = `Admin_${prenom.trim()}`;
    }

    const exists = await User.findOne({ $or: [{ email }, { pseudo }] });
    if (exists) {
      return res.status(409).json({ ok: false, error: 'Email ou pseudo déjà utilisé.' });
    }

    const user = await User.create({ prenom, nom, email, pseudo, password, role });
    return res.json({
      ok: true,
      user: { pseudo: user.pseudo, role: user.role, prenom: user.prenom }
    });
  } catch (e) {
    console.error('[REGISTER]', e);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
});

/**
 * POST /api/login
 * Authentification simple par pseudo + mot de passe.
 * Renvoie l'historique des 50 derniers messages du salon "general".
 */
app.post('/api/login', async (req, res) => {
  try {
    const { pseudo, password } = req.body;
    if (!pseudo || !password) {
      return res.status(400).json({ ok: false, error: 'Pseudo et mot de passe requis.' });
    }

    const user = await User.findOne({ pseudo });
    if (!user || user.password !== password) {
      return res.status(401).json({ ok: false, error: 'Identifiants incorrects.' });
    }

    const history = await Message
      .find({ salon: 'general' })
      .sort({ date: -1 })
      .limit(50)
      .lean();

    return res.json({
      ok: true,
      user: { pseudo: user.pseudo, role: user.role, prenom: user.prenom },
      history: history.reverse()
    });
  } catch (e) {
    console.error('[LOGIN]', e);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
});

/**
 * GET /api/history/:salon
 * Récupère l'historique d'un salon donné (50 derniers messages).
 */
app.get('/api/history/:salon', async (req, res) => {
  try {
    const salon = req.params.salon || 'general';
    const history = await Message
      .find({ salon })
      .sort({ date: -1 })
      .limit(50)
      .lean();
    return res.json({ ok: true, history: history.reverse() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
});

/* ---------------------------------------------------------------------
 *  Serveur HTTP + Socket.io
 * ------------------------------------------------------------------- */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/**
 * Liste des utilisateurs connectés en mémoire (clé = socket.id).
 * Utilisée pour la "Liste des membres connectés" côté UI.
 */
const onlineUsers = new Map();

/**
 * Diffuse à tous les clients la liste à jour des membres en ligne.
 */
function broadcastMembers() {
  const members = Array.from(onlineUsers.values());
  io.emit('members:update', members);
}

io.on('connection', (socket) => {
  console.log('[Socket] Connexion', socket.id);

  /**
   * Le client annonce son identité juste après s'être connecté
   * (login ou inscription réussie côté front).
   */
  socket.on('user:join', ({ pseudo, role, salon }) => {
    onlineUsers.set(socket.id, {
      id: socket.id,
      pseudo: pseudo || 'Inconnu',
      role:   role   || 'user',
      salon:  salon  || 'general'
    });
    socket.join(salon || 'general');
    broadcastMembers();
  });

  /**
   * Changement de salon : on quitte l'ancien et rejoint le nouveau.
   */
  socket.on('salon:change', async ({ salon }) => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;
    socket.leave(u.salon);
    u.salon = salon;
    socket.join(salon);
    onlineUsers.set(socket.id, u);

    const history = await Message
      .find({ salon })
      .sort({ date: -1 })
      .limit(50)
      .lean();
    socket.emit('history:load', history.reverse());
    broadcastMembers();
  });

  /**
   * Réception d'un nouveau message :
   *  1. Persistance MongoDB
   *  2. Diffusion à tous les clients du salon
   */
  socket.on('message:send', async ({ texte }) => {
    try {
      const u = onlineUsers.get(socket.id);
      if (!u || !texte || !texte.trim()) return;

      const msg = await Message.create({
        auteur: u.pseudo,
        role:   u.role,
        texte:  texte.trim().slice(0, 2000),
        salon:  u.salon
      });

      io.to(u.salon).emit('message:new', {
        auteur: msg.auteur,
        role:   msg.role,
        texte:  msg.texte,
        date:   msg.date,
        salon:  msg.salon
      });
    } catch (e) {
      console.error('[message:send]', e);
      socket.emit('error:notify', { message: 'Impossible d\'envoyer le message.' });
    }
  });

  /**
   * Indicateur "X est en train d'écrire..."
   */
  socket.on('typing', (isTyping) => {
    const u = onlineUsers.get(socket.id);
    if (!u) return;
    socket.to(u.salon).emit('typing', { pseudo: u.pseudo, isTyping });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastMembers();
    console.log('[Socket] Déconnexion', socket.id);
  });
});

/* ---------------------------------------------------------------------
 *  Démarrage
 * ------------------------------------------------------------------- */
server.listen(PORT, () => {
  console.log(`🚀 AnonChat démarré sur http://localhost:${PORT}`);
});
