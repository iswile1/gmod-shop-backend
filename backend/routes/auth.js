/**
 * Routes d'authentification
 * Inscription, connexion, gestion des sessions
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { generateToken } = require('../config/jwt');
const { getDatabase, getDatabaseType } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/register
 * Inscription d'un nouvel utilisateur
 */
router.post('/register', [
  body('username').trim().isLength({ min: 3, max: 50 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('steam_id').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { username, email, password, steam_id } = req.body;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    // Vérifier que la base de données est disponible
    if (!db || !dbType) {
      return res.status(503).json({ error: 'Base de données non disponible. Veuillez réessayer plus tard.' });
    }
    
    // Vérifier si l'utilisateur existe déjà
    let existingUser;
    if (dbType === 'postgresql') {
      const emailCheck = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Email déjà utilisé' });
      }
      if (steam_id) {
        const steamCheck = await db.query('SELECT id FROM users WHERE steam_id = $1', [steam_id]);
        if (steamCheck.rows.length > 0) {
          return res.status(400).json({ error: 'Steam ID déjà utilisé' });
        }
      }
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      existingUser = await User.findOne({ $or: [{ email }, { steam_id }] });
      if (existingUser) {
        return res.status(400).json({ error: 'Email ou Steam ID déjà utilisé' });
      }
    }
    
    // Hasher le mot de passe
    const password_hash = await bcrypt.hash(password, 10);
    
    // Créer l'utilisateur
    let user;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'INSERT INTO users (username, email, password_hash, steam_id) VALUES ($1, $2, $3, $4) RETURNING id, username, email, credits, role, steam_id',
        [username, email, password_hash, steam_id || null]
      );
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.create({
        username,
        email,
        password_hash,
        steam_id: steam_id || undefined
      });
      user = user.toObject();
      delete user.password_hash;
    }
    
    // Générer le token
    const token = generateToken({ userId: user.id });
    
    res.status(201).json({
      message: 'Inscription réussie',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        credits: user.credits || 0,
        role: user.role || 'user',
        steam_id: user.steam_id
      }
    });
  } catch (error) {
    console.error('Erreur inscription:', error);
    // Retourner un message d'erreur plus détaillé en développement
    const errorMessage = process.env.NODE_ENV === 'development' 
      ? error.message 
      : 'Erreur serveur lors de l\'inscription';
    res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/auth/login
 * Connexion d'un utilisateur
 */
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { email, password } = req.body;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    // Vérifier que la base de données est disponible
    if (!db || !dbType) {
      return res.status(503).json({ error: 'Base de données non disponible. Veuillez réessayer plus tard.' });
    }
    
    // Récupérer l'utilisateur
    let user;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT id, username, email, password_hash, credits, role, steam_id FROM users WHERE email = $1',
        [email]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Identifiants invalides' });
      }
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findOne({ email });
      if (!user) {
        return res.status(401).json({ error: 'Identifiants invalides' });
      }
      user = user.toObject();
    }
    
    // Vérifier le mot de passe
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    
    // Générer le token
    const token = generateToken({ userId: user.id });
    
    res.json({
      message: 'Connexion réussie',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        credits: user.credits || 0,
        role: user.role || 'user',
        steam_id: user.steam_id
      }
    });
  } catch (error) {
    console.error('Erreur connexion:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/auth/me
 * Récupère les informations de l'utilisateur connecté
 */
router.get('/me', authenticate, async (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      credits: req.user.credits || 0,
      role: req.user.role || 'user',
      steam_id: req.user.steam_id
    }
  });
});

/**
 * GET /api/auth/steam
 * Démarre l'authentification Steam
 */
router.get('/steam', (req, res, next) => {
  const passport = require('../config/steam');
  passport.authenticate('steam', { failureRedirect: '/' })(req, res, next);
});

/**
 * GET /api/auth/steam/return
 * Callback Steam après authentification
 */
router.get('/steam/return', async (req, res, next) => {
  console.log('🔐 Steam return callback appelé');
  console.log('📥 Query params:', req.query);
  
  const passport = require('../config/steam');
  const { getDatabase, getDatabaseType } = require('../config/database');
  const { generateToken } = require('../config/jwt');
  
  passport.authenticate('steam', async (err, steamUser) => {
    console.log('🔐 Steam authenticate callback');
    console.log('❌ Erreur:', err);
    console.log('👤 Steam User:', steamUser);
    
    if (err || !steamUser) {
      console.error('❌ Erreur authentification Steam:', err);
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=steam_auth_failed`);
    }
    
    try {
      const db = getDatabase();
      const dbType = getDatabaseType();
      
      if (!db || !dbType) {
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/login?error=database_unavailable`);
      }
      
      // Chercher ou créer l'utilisateur
      let user;
      if (dbType === 'postgresql') {
        // Chercher l'utilisateur par Steam ID
        const result = await db.query(
          'SELECT id, username, email, credits, role, steam_id FROM users WHERE steam_id = $1',
          [steamUser.steamId]
        );
        
        if (result.rows.length > 0) {
          // Utilisateur existant
          user = result.rows[0];
        } else {
          // Créer un nouvel utilisateur (sans password_hash pour Steam)
          const insertResult = await db.query(
            'INSERT INTO users (username, steam_id, email, password_hash) VALUES ($1, $2, $3, NULL) RETURNING id, username, email, credits, role, steam_id',
            [steamUser.username, steamUser.steamId, `${steamUser.steamId}@steam.local`]
          );
          user = insertResult.rows[0];
        }
      } else if (dbType === 'mongodb') {
        const User = require('../models/User');
        user = await User.findOne({ steam_id: steamUser.steamId });
        
        if (!user) {
          user = await User.create({
            username: steamUser.username,
            steam_id: steamUser.steamId,
            email: `${steamUser.steamId}@steam.local`
          });
        }
        user = user.toObject();
      }
      
      // Générer le token JWT
      const token = generateToken({ userId: user.id });
      console.log('✅ Token généré pour user:', user.id);
      console.log('✅ User créé/trouvé:', { id: user.id, username: user.username, steamId: user.steam_id });
      
      // Rediriger vers le frontend avec le token
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const redirectUrl = `${frontendUrl}/auth/callback?token=${token}&steamId=${steamUser.steamId}`;
      console.log('🔄 Redirection vers:', redirectUrl);
      res.redirect(redirectUrl);
      
    } catch (error) {
      console.error('❌ Erreur authentification Steam:', error);
      console.error('❌ Message:', error.message);
      console.error('❌ Stack:', error.stack);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const errorMessage = process.env.NODE_ENV === 'development' ? error.message : 'server_error';
      res.redirect(`${frontendUrl}/login?error=${errorMessage}`);
    }
  })(req, res, next);
});

module.exports = router;
