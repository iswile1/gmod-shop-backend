/**
 * Modèle Product pour MongoDB
 */

const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  type: {
    type: String,
    enum: ['credits', 'weapon_perm', 'skin'],
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  credits_amount: {
    type: Number,
    default: 0
  },
  item_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  image_url: {
    type: String,
    default: ''
  },
  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Product', productSchema);
