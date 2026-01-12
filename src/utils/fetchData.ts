import axios from 'axios';

const fetchData = async (url: string) => {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error: any) {
            const isLastAttempt = attempt === maxRetries;
            const status = error.response?.status;
            const isRetryableStatus = status === 429 || (status >= 500 && status <= 599);
            const isNetworkError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' || !error.response;

            if ((isNetworkError || isRetryableStatus) && !isLastAttempt) {
                const delay = baseDelay * Math.pow(2, attempt);
                const errorMsg = status ? `Status ${status}` : (error.code || 'Network error');
                console.log(`[RETRY] ${errorMsg} fetching data, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            // Either not retryable, or we've exhausted retries
            const finalError = status ? `HTTP ${status} ${error.response?.statusText || ''}` : (error.message || 'Unknown error');
            console.error(`Error fetching data from ${url}: ${finalError}`);
            throw new Error(finalError);
        }
    }
};

export default fetchData;
