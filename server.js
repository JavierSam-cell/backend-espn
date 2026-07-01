const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Partidos en vivo
app.get('/api/live-matches', async (req, res) => {
  try {
    const { scrapearPartidosEnVivo } = require('./scraper-espn-live');
    const { partidos, debug } = await scrapearPartidosEnVivo();
    res.json({
      success: true,
      data: partidos,
      total: partidos.length,
      timestamp: new Date().toISOString(),
      // 🔍 Temporal mientras se depura por qué no aparecen partidos en vivo.
      // Quítalo (o pon detrás de ?debug=1) una vez resuelto.
      debug
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'API funcionando' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});