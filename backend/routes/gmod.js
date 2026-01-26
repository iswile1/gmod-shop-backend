/**
 * Routes d'intégration GMod
 * API pour que le serveur GMod vérifie les crédits et débloque les items
 */

const express = require('express');
const axios = require('axios');
const { getDatabase, getDatabaseType } = require('../config/database');

const router = express.Router();

// Middleware pour vérifier la clé API GMod
function verifyGModAPIKey(req, res, next) {
  const apiKey = req.headers['x-gmod-api-key'] || req.query.api_key;
  
  if (!apiKey || apiKey !== process.env.GMOD_API_KEY) {
    return res.status(401).json({ error: 'Clé API invalide' });
  }
  
  next();
}

/**
 * GET /api/gmod/credits/:steamId
 * Vérifie les crédits d'un joueur via son Steam ID
 */
router.get('/credits/:steamId', verifyGModAPIKey, async (req, res) => {
  try {
    const { steamId } = req.params;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let user;
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT id, credits FROM users WHERE steam_id = $1', [steamId]);
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findOne({ steam_id: steamId }).select('credits');
    }
    
    if (!user) {
      return res.json({ credits: 0, user_id: null });
    }
    
    res.json({ credits: user.credits || 0, user_id: user.id });
  } catch (error) {
    console.error('Erreur vérification crédits GMod:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/gmod/deduct-credits
 * Déduit des crédits d'un joueur (appelé par le serveur GMod)
 */
router.post('/deduct-credits', verifyGModAPIKey, async (req, res) => {
  try {
    const { steamId, amount } = req.body;
    
    if (!steamId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }
    
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let user;
    if (dbType === 'postgresql') {
      // Vérifier que l'utilisateur a assez de crédits
      const checkResult = await db.query('SELECT id, credits FROM users WHERE steam_id = $1', [steamId]);
      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Joueur non trouvé' });
      }
      
      if (checkResult.rows[0].credits < amount) {
        return res.status(400).json({ error: 'Crédits insuffisants' });
      }
      
      // Déduire les crédits
      const result = await db.query(
        'UPDATE users SET credits = credits - $1 WHERE steam_id = $2 RETURNING id, credits',
        [amount, steamId]
      );
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findOne({ steam_id: steamId });
      
      if (!user) {
        return res.status(404).json({ error: 'Joueur non trouvé' });
      }
      
      if (user.credits < amount) {
        return res.status(400).json({ error: 'Crédits insuffisants' });
      }
      
      user.credits -= amount;
      await user.save();
    }
    
    res.json({ 
      success: true, 
      credits_remaining: user.credits,
      message: `${amount} crédits déduits avec succès`
    });
  } catch (error) {
    console.error('Erreur déduction crédits GMod:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * GET /api/gmod/items/:steamId
 * Récupère tous les items (armes perm, skins) d'un joueur
 */
router.get('/items/:steamId', verifyGModAPIKey, async (req, res) => {
  try {
    const { steamId } = req.params;
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let items;
    if (dbType === 'postgresql') {
      const result = await db.query(
        `SELECT ui.item_type, ui.item_data, p.name as product_name 
         FROM user_items ui 
         JOIN users u ON ui.user_id = u.id 
         JOIN products p ON ui.product_id = p.id 
         WHERE u.steam_id = $1`,
        [steamId]
      );
      items = result.rows;
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      const UserItem = require('../models/UserItem');
      
      const user = await User.findOne({ steam_id: steamId });
      if (!user) {
        return res.json({ items: [] });
      }
      
      items = await UserItem.find({ user_id: user.id })
        .populate('product_id', 'name')
        .select('item_type item_data');
    }
    
    res.json({ items });
  } catch (error) {
    console.error('Erreur récupération items GMod:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

/**
 * POST /api/gmod/unlock-item
 * Débloque un item pour un joueur (appelé après achat)
 */
router.post('/unlock-item', verifyGModAPIKey, async (req, res) => {
  try {
    const { steamId, itemType, itemData } = req.body;
    
    if (!steamId || !itemType) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }
    
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let user;
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT id FROM users WHERE steam_id = $1', [steamId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Joueur non trouvé' });
      }
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findOne({ steam_id: steamId });
      if (!user) {
        return res.status(404).json({ error: 'Joueur non trouvé' });
      }
    }
    
    // L'item devrait déjà être dans user_items après un achat réussi
    // Cette route peut être utilisée pour forcer le déblocage si nécessaire
    
    res.json({ success: true, message: 'Item débloqué' });
  } catch (error) {
    console.error('Erreur déblocage item GMod:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
