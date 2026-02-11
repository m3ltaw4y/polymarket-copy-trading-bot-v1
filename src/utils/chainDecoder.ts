import { ethers } from 'ethers';

export interface DecodedTrade {
    transactionHash: string;
    maker: string; // The user sending the trade (Target/Proxy)
    assetId: string;
    side: 'BUY' | 'SELL' | 'UNKNOWN';
    size: number; // Net Shares
    usdcSpent?: number; // For price calculation
    price?: number; // Calculated Price
    timestamp: number;
}

const ERC1155_ABI = [
    "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
    "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
];

const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon USDC

export class ChainDecoder {
    private iface1155: ethers.utils.Interface;
    private iface20: ethers.utils.Interface;

    constructor() {
        this.iface1155 = new ethers.utils.Interface(ERC1155_ABI);
        this.iface20 = new ethers.utils.Interface(ERC20_ABI);
    }

    /**
     * Decodes a transaction receipt to find trade details for a specific user (EOA or Proxy).
     */
    public decodeTrade(receipt: ethers.providers.TransactionReceipt, targetAddress: string, proxyAddress: string | null): DecodedTrade | null {
        const targetLower = targetAddress.toLowerCase();
        const proxyLower = proxyAddress ? proxyAddress.toLowerCase() : null;

        // Maps assetId -> { totalShares: BigNumber, side: string }
        const assets = new Map<string, { total: ethers.BigNumber, side: 'BUY' | 'SELL' | 'UNKNOWN' }>();
        let totalUsdc = ethers.BigNumber.from(0);

        for (const log of receipt.logs) {
            // 1. Check for ERC1155 (Shares)
            try {
                const parsed = this.iface1155.parseLog(log);
                if (parsed.name === 'TransferSingle') {
                    const { from, to, id, value } = parsed.args;
                    this.processTransfer(assets, id.toString(), from, to, value, targetLower, proxyLower);
                } else if (parsed.name === 'TransferBatch') {
                    const args = parsed.args as any;
                    const { from, to, ids, values } = args;
                    for (let i = 0; i < ids.length; i++) {
                        this.processTransfer(assets, ids[i].toString(), from, to, values[i], targetLower, proxyLower);
                    }
                }
            } catch (e) { /* Not an ERC1155 log */ }

            // 2. Check for USDC Transfer (Price Calculation)
            if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
                try {
                    const parsed = this.iface20.parseLog(log);
                    if (parsed.name === 'Transfer') {
                        const { from, to, value } = parsed.args;
                        const fromLower = from.toLowerCase();
                        const toLower = to.toLowerCase();

                        if (fromLower === targetLower || (proxyLower && fromLower === proxyLower)) {
                            totalUsdc = totalUsdc.add(value);
                        } else if (toLower === targetLower || (proxyLower && toLower === proxyLower)) {
                            totalUsdc = totalUsdc.add(value);
                        }
                    }
                } catch (e) { /* Not an ERC20 log */ }
            }
        }

        // Pick the asset with the HIGHEST share movement (usually the trade target)
        let bestAsset = '';
        let bestInfo: { total: ethers.BigNumber, side: 'BUY' | 'SELL' | 'UNKNOWN' } | null = null;

        for (const [id, info] of assets.entries()) {
            if (!bestInfo || info.total.gt(bestInfo.total)) {
                bestAsset = id;
                bestInfo = info;
            }
        }

        if (bestAsset && bestInfo && bestInfo.total.gt(0)) {
            const size = parseFloat(ethers.utils.formatUnits(bestInfo.total, 6));
            const usdcVal = parseFloat(ethers.utils.formatUnits(totalUsdc, 6));

            let price = size > 0 ? usdcVal / size : 0;
            if (price > 1.0) price = 0;

            return {
                transactionHash: receipt.transactionHash,
                maker: targetAddress,
                assetId: bestAsset,
                side: bestInfo.side,
                size: size,
                usdcSpent: usdcVal,
                price: price,
                timestamp: Date.now()
            };
        }

        return null;
    }

    private processTransfer(
        assets: Map<string, { total: ethers.BigNumber, side: 'BUY' | 'SELL' | 'UNKNOWN' }>,
        id: string,
        from: string,
        to: string,
        value: ethers.BigNumber,
        target: string,
        proxy: string | null
    ) {
        const fromLower = from.toLowerCase();
        const toLower = to.toLowerCase();
        const targetIsReceiver = toLower === target || (proxy && toLower === proxy);
        const targetIsSender = fromLower === target || (proxy && fromLower === proxy);

        if (!assets.has(id)) {
            assets.set(id, { total: ethers.BigNumber.from(0), side: 'UNKNOWN' });
        }
        const info = assets.get(id)!;

        if (targetIsReceiver) {
            info.side = 'BUY';
            info.total = info.total.add(value);
        } else if (targetIsSender) {
            info.side = 'SELL';
            info.total = info.total.add(value);
        }
    }
}
