import { algoMonitor } from './monitor';
import { algoPredictor } from './predictor';
import { algoExecutor } from './executor';

const main = async () => {
    console.log('====================================');
    console.log('🚀 INITIALIZING ALGO TRADING MODE');
    console.log('====================================');

    await algoMonitor();
    await algoPredictor();
    await algoExecutor();
};

main().catch(console.error);
