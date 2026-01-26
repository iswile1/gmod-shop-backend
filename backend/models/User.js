/**
 * Modèle User pour MongoDB
 * (Alternative si vous utilisez MongoDB au lieu de PostgreSQL)
 */

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  steam_id: {
    type: String,
    unique: true,
    sparse: true
  },
  username: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password_hash: {
    type: String,
    required: true
  },
  credits: {
    type: Number,
    default: 0
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances
userSchema.index({ steam_id: 1 });
userSchema.index({ email: 1 });

module.exports = mongoose.model('User', userSchema);
