import mongoose, { Schema } from 'mongoose';

const dryRunPositionSchema = new Schema({
    conditionId: { type: String, required: true },
    title: { type: String, required: true },
    outcome: { type: String, required: true }, // 'Yes' or 'No' or other
    totalSpend: { type: Number, default: 0 },
    totalShares: { type: Number, default: 0 },
    avgPrice: { type: Number, default: 0 },
    totalReturn: { type: Number, default: 0 },
    isClosed: { type: Boolean, default: false },
});

// Compound index to quickly find position for a market and outcome
dryRunPositionSchema.index({ conditionId: 1, outcome: 1 }, { unique: true });

const DryRunPosition = mongoose.model('DryRunPosition', dryRunPositionSchema);

const dryRunTradeSchema = new Schema({
    title: { type: String, required: true },
    side: { type: String, required: true }, // 'BUY' or 'SELL'
    outcome: { type: String, required: true },
    price: { type: Number, required: true },
    size: { type: Number, required: true },
    usdcSize: { type: Number, required: true },
    timestamp: { type: Number, required: true },
});

const DryRunTrade = mongoose.model('DryRunTrade', dryRunTradeSchema);

export { DryRunPosition, DryRunTrade };
