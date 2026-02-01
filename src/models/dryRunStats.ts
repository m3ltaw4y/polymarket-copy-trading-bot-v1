import mongoose, { Schema } from 'mongoose';

const dryRunStatsSchema = new Schema({
    totalSpend: { type: Number, default: 0 },
    totalReturns: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    winningPositions: { type: Number, default: 0 },
    losingPositions: { type: Number, default: 0 },
    netPnL: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now },
});

const DryRunStats = mongoose.model('DryRunStats', dryRunStatsSchema);

export { DryRunStats };
