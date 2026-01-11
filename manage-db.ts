import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const dryRunPositionSchema = new mongoose.Schema({
    conditionId: String,
    title: String,
    outcome: String,
    totalShares: Number,
    totalSpend: Number,
    avgPrice: Number,
    totalReturn: Number,
    isClosed: Boolean,
});

const DryRunPosition = mongoose.model('DryRunPosition', dryRunPositionSchema);

const dryRunTradeSchema = new mongoose.Schema({
    title: String,
    side: String,
    outcome: String,
    price: Number,
    size: Number,
    usdcSize: Number,
    timestamp: Number,
});

const DryRunTrade = mongoose.model('DryRunTrade', dryRunTradeSchema);

async function run() {
    await mongoose.connect(process.env.MONGO_URI!);

    if (process.argv.includes('--clear')) {
        await DryRunTrade.deleteMany({});
        await DryRunPosition.deleteMany({});
        console.log('Cleared all dry run data.');
        await mongoose.disconnect();
        return;
    }

    const positions = await DryRunPosition.find({ isClosed: false });
    console.log(`Found ${positions.length} ACTIVE dry run positions:`);
    positions.forEach(p => {
        console.log(`- ${p.title} | ID: ${p.conditionId} | Outcome: ${p.outcome}`);
    });

    await mongoose.disconnect();
}

run();
