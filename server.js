require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const questRoutes = require('./routes/quests');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname)));

// Routes
app.use('/api', questRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server running' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

app.listen(PORT, () => {
  console.log(`🎮 Last Chad Quest Server running on http://localhost:${PORT}`);
});
