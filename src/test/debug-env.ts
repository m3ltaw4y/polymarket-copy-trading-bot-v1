import * as dotenv from 'dotenv';
dotenv.config();

console.log('TRADE_EXACT raw value:', JSON.stringify(process.env.TRADE_EXACT));
console.log('TRADE_EXACT parsed boolean:', process.env.TRADE_EXACT === '1');
