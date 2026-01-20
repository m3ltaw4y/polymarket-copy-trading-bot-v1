import { ENV } from '../config/env';

const CHAINLINK_API_BASE = 'https://api.dataengine.chain.link';

interface ChainlinkReport {
    fullReport: string;
    feedID: string;
    validFromTimestamp: number;
    observationsTimestamp: number;
}

/**
 * Fetch historical BTC price from Chainlink Data Streams at a specific timestamp
 * @param timestamp Unix timestamp in seconds
 * @returns BTC price at that timestamp, or null if not found
 */
export async function getBTCPriceAtTimestamp(timestamp: number): Promise<number | null> {
    try {
        const feedId = ENV.BTC_DATA_STREAM;
        if (!feedId) {
            console.error('BTC_DATA_STREAM not configured');
            return null;
        }

        // Chainlink API endpoint for historical reports
        const url = `${CHAINLINK_API_BASE}/api/v1/reports/page/${feedId}?timestamp=${timestamp}&limit=1`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${ENV.API_KEY}`,
                'X-Authorization-User-Secret': ENV.USER_SECRET,
            },
        });

        if (!response.ok) {
            console.error(`Chainlink API error: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();

        // The API returns an array of reports
        if (Array.isArray(data) && data.length > 0) {
            const report = data[0];

            // Decode the price from the report
            // The report contains a hex-encoded payload that needs to be decoded
            // For now, we'll use the median price from the benchmark field if available
            if (report.price) {
                return parseFloat(report.price);
            }

            // Alternative: parse from fullReport blob
            // This would require decoding the Chainlink report format
            console.warn('Price not directly available in response, may need report decoding');
        }

        return null;
    } catch (error) {
        console.error('Error fetching historical BTC price:', error instanceof Error ? error.message : error);
        return null;
    }
}

/**
 * Fetch BTC prices at multiple timestamps
 * @param timestamps Array of Unix timestamps in seconds
 * @returns Map of timestamp -> price
 */
export async function getBTCPricesAtTimestamps(timestamps: number[]): Promise<Map<number, number>> {
    const priceMap = new Map<number, number>();

    // Fetch prices sequentially to avoid rate limiting
    for (const timestamp of timestamps) {
        const price = await getBTCPriceAtTimestamp(timestamp);
        if (price !== null) {
            priceMap.set(timestamp, price);
        }
        // Delay to avoid rate limiting (Chainlink has strict limits)
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return priceMap;
}
