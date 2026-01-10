const mongoose = require('mongoose');

const MONGO_URI = 'mongodb://localhost:27017/polymarket_copytrading';

console.log(`Attempting to connect to MongoDB at: ${MONGO_URI}`);

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ Successfully connected to MongoDB!');
        process.exit(0);
    })
    .catch((err) => {
        console.error('❌ Failed to connect to MongoDB:', err.message);
        process.exit(1);
    });
