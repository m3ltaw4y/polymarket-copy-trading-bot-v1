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
            const isNetworkError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND';

            if (isNetworkError && !isLastAttempt) {
                const delay = baseDelay * Math.pow(2, attempt); // Exponential backoff
                console.log(`Network error (${error.code}), retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            // Either not a network error, or we've exhausted retries
            console.error('Error fetching data:', error);
            throw error;
        }
    }
};

export default fetchData;
