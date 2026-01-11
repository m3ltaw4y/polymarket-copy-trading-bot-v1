import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const userActivitySchema = new mongoose.Schema({
    conditionId: String,
    title: String,
    outcome: String,
    bot: Boolean,
    timestamp: Number,
}, { strict: false });

const UserActivity = mongoose.model('user_activities_' + process.env.USER_ADDRESS, userActivitySchema);

async function run() {
    await mongoose.connect(process.env.MONGO_URI!);
    const conditionId = '0x8faff2f46f82e463eda4679a763893e41e3dc4982535ee3ec2ad955936ebb9e3';
    const activities = await UserActivity.find({ conditionId });
    console.log(`Found ${activities.length} activities for 0x8faff...:`);
    activities.forEach((a: any) => {
        console.log(`- Bot: ${a.bot} | Title: ${a.title} | Side: ${a.side} | TS: ${a.timestamp}`);
    });

    await mongoose.disconnect();
}

run();
