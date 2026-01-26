/**
 * Middleware d'authentification
 * Vérifie les tokens JWT et attache l'utilisateur à la requête
 */

const { verifyToken } = require('../config/jwt');
const { getDatabase, getDatabaseType } = require('../config/database');

/**
 * Middleware pour vérifier l'authentification
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant' });
    }
    
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    
    // Récupérer l'utilisateur depuis la base de données
    const db = getDatabase();
    const dbType = getDatabaseType();
    
    let user;
    
    if (dbType === 'postgresql') {
      const result = await db.query('SELECT id, steam_id, username, email, credits, role FROM users WHERE id = $1', [decoded.userId]);
      user = result.rows[0];
    } else if (dbType === 'mongodb') {
      const User = require('../models/User');
      user = await User.findById(decoded.userId).select('-password_hash');
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Utilisateur non trouvé' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

/**
 * Middleware pour vérifier le rôle admin
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès admin requis' });
  }
  next();
}

module.exports = {
  authenticate,
  requireAdmin
};
