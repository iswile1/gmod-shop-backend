/**
 * Modèle UserItem pour MongoDB
 */

const mongoose = require('mongoose');

const userItemSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  product_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  item_type: {
    type: String,
    enum: ['weapon_perm', 'skin'],
    required: true
  },
  item_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('UserItem', userItemSchema);
