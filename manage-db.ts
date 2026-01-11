import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const dryRunPositionSchema = new mongoose.Schema({
    conditionId: String,
    title: String,
    outcome: String,
    totalShares: Number,
    isClosed: Boolean,
});

const DryRunPosition = mongoose.model('DryRunPosition', dryRunPositionSchema);

async function run() {
    await mongoose.connect(process.env.MONGO_URI!);
    const positions = await DryRunPosition.find({});
    console.log(`Found ${positions.length} dry run positions:`);
    positions.forEach(p => {
        console.log(`- [${p.isClosed ? 'CLOSED' : 'ACTIVE'}] ${p.title} (${p.outcome}) | ID: ${p.conditionId} | Shares: ${p.totalShares}`);
    });

    // To clear them, the user can run with an argument
    if (process.argv.includes('--clear')) {
        await DryRunPosition.deleteMany({});
        console.log('Cleared all dry run positions.');
    }

    await mongoose.disconnect();
}

run();
