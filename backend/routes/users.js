/**
 * Routes pour les utilisateurs
 * Profil, crédits, inventaire
 */

const express = require('express');
const { getDatabase, getDatabaseType } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Toutes les routes nécessitent l'authentification
router.use(authenticate);

/**
 * GET /api/users/profile
 * Récupère le profil de l'utilisateur
 */
router.get('/profile', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let user;
    if (dbType === 'postgresql') {
      const result = await db.query(
        'SELECT id, username, email, credits, role, steam_id, created_at FROM users WHERE id = $1',
        [req.user.id]
      );
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findById(req.user.id).select('-password_hash');
    }
    
    res.json({ user });
  } catch (error) {
    console.error('Erreur récupération profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/users/inventory
 * Récupère l'inventaire de l'utilisateur (armes perm, skins)
 */
router.get('/inventory', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let items;
    if (dbType === 'postgresql') {
      const result = await db.query(
        `SELECT ui.*, p.name as product_name, p.type as product_type, p.image_url 
         FROM user_items ui 
         JOIN products p ON ui.product_id = p.id 
         WHERE ui.user_id = $1 
         ORDER BY ui.created_at DESC`,
        [req.user.id]
      );
      items = result.rows;
    } else if (dbType === 'mongodb') {
      const UserItem = require('../models/UserItem');
      items = await UserItem.find({ user_id: req.user.id })
        .populate('product_id', 'name type image_url')
        .sort({ createdAt: -1 });
    }
    
    res.json({ items });
  } catch (error) {
    console.error('Erreur récupération inventaire:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/users/credits
 * Récupère les crédits de l'utilisateur
 */
router.get('/credits', async (req, res) => {
  try {
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let credits;
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
      credits = result.rows[0]?.credits || 0;
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      const user = await User.findById(req.user.id).select('credits');
      credits = user?.credits || 0;
    }
    
    res.json({ credits });
  } catch (error) {
    console.error('Erreur récupération crédits:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
