"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const yahoo_finance2_1 = __importDefault(require("yahoo-finance2"));
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const dotenv_1 = __importDefault(require("dotenv"));
const data_1 = require("./data");
// Suppress Yahoo Finance survey notice
yahoo_finance2_1.default.suppressNotices(['yahooSurvey']);
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = process.env.PORT || 3001;
// const redis = process.env.REDIS_URL
//   ? new Redis(process.env.REDIS_URL)
//   : new Redis({
//       host: process.env.REDIS_HOST || 'localhost',
//       port: parseInt(process.env.REDIS_PORT || '6379'),
//       password: process.env.REDIS_PASSWORD,
//       tls: process.env.REDIS_HOST?.includes('upstash') ? {} : undefined,
//     });
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Rate limiter to prevent API abuse
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
});
app.use(limiter);
// Cache keys
const CACHE_TTL = 60; // Cache for 60 seconds
// Check if Indian market is open (9:15 AM to 3:30 PM IST, Mon-Fri)
function isMarketOpen() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = istTime.getDay();
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const timeInMinutes = hours * 60 + minutes;
    const marketOpen = 9 * 60 + 15; // 9:15 AM
    const marketClose = 15 * 60 + 30; // 3:30 PM
    const isOpen = day >= 1 && day <= 5 && timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
    console.log('IST Day:', day, 'Hours:', hours, 'Minutes:', minutes, 'Market Open:', isOpen);
    return isOpen;
}
// Convert Yahoo ticker to Google Finance ticker
function convertToGoogleFinanceTicker(yahooSymbol) {
    // Remove '.NS' or '.BO' suffix and append ':NSE' or ':BSE'
    const exchange = yahooSymbol.endsWith('.NS') ? 'NSE' : yahooSymbol.endsWith('.BO') ? 'BSE' : 'NSE';
    const ticker = yahooSymbol.replace(/\.NS$|\.BO$/, '');
    return `${ticker}:${exchange}`;
}
// Fetch CMP from Yahoo Finance
async function fetchCMP(symbol, staticCMP) {
    // const cacheKey = `cmp:${symbol}`;
    // const cachedCMP = await redis.get(cacheKey);
    // if (cachedCMP) return parseFloat(cachedCMP);
    // if (!isMarketOpen()) {
    //   console.warn(`Market is closed. Using static CMP (${staticCMP}) for ${symbol}`);
    //   return staticCMP;
    // }
    try {
        const quote = await yahoo_finance2_1.default.quote(symbol);
        if (!quote || !quote.regularMarketPrice) {
            console.warn(`No CMP data for ${symbol}. Using static CMP (${staticCMP})`);
            return staticCMP;
        }
        const cmp = quote.regularMarketPrice;
        // await redis.set(cacheKey, cmp, 'EX', CACHE_TTL);
        console.log('Fetching CMP from Yahoo Finance:', symbol, 'Result:', cmp);
        return cmp;
    }
    catch (error) {
        console.error(`Error fetching CMP for ${symbol}:`, error.message);
        console.warn(`Using static CMP (${staticCMP}) for ${symbol}`);
        return staticCMP;
    }
}
// Fetch P/E Ratio and EPS from Google Finance
async function fetchGoogleFinanceData(ticker) {
    const cacheKey = `googleFinance:${ticker}`;
    // const cachedData = await redis.get(cacheKey);
    // if (cachedData) return JSON.parse(cachedData);
    try {
        const url = `https://www.google.com/finance/quote/${ticker}`;
        const response = await axios_1.default.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(response.data);
        let peRatio = 'N/A';
        let latestEarnings = 'N/A';
        // Search for P/E ratio
        $('*:contains("P/E ratio")').each((i, element) => {
            const value = $(element).next().text().trim() || $(element).find('p').text().trim() || $(element).parent().next().text().trim();
            if (value && !isNaN(parseFloat(value))) {
                peRatio = value;
            }
        });
        // Search for Earnings per share
        $('*:contains("Earnings per share")').each((i, element) => {
            const value = $(element).next().text().trim() || $(element).find('p').text().trim() || $(element).parent().next().text().trim();
            if (value && !isNaN(parseFloat(value))) {
                latestEarnings = value;
            }
        });
        const data = { peRatio, latestEarnings };
        // await redis.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL);
        console.log(`Fetched Google Finance data for ${ticker}:`, data);
        return data;
    }
    catch (error) {
        console.error(`Error fetching Google Finance data for ${ticker}:`, error.message);
        return { peRatio: 'Error', latestEarnings: 'Error' };
    }
}
// Calculate sector summaries
function calculateSectorSummaries(portfolioData) {
    const sectors = portfolioData.reduce((acc, stock) => {
        const { sector, investment, presentValue, gainLoss, marketCap, revenueTTM, ebitdaTTM, pat } = stock;
        if (!acc[sector]) {
            acc[sector] = {
                totalInvestment: 0,
                totalPresentValue: 0,
                totalGainLoss: 0,
                totalMarketCap: 0,
                totalRevenueTTM: 0,
                totalEbitdaTTM: 0,
                totalPat: 0,
            };
        }
        acc[sector].totalInvestment += investment;
        acc[sector].totalPresentValue += presentValue;
        acc[sector].totalGainLoss += gainLoss;
        acc[sector].totalMarketCap += marketCap || 0;
        acc[sector].totalRevenueTTM += revenueTTM || 0;
        acc[sector].totalEbitdaTTM += ebitdaTTM || 0;
        acc[sector].totalPat += pat || 0;
        return acc;
    }, {});
    return sectors;
}
// API endpoint to get portfolio data
app.get('/api/portfolio', async (req, res) => {
    try {
        const portfolioData = await Promise.all(data_1.portfolio.map(async (stock) => {
            const googleTicker = convertToGoogleFinanceTicker(stock.yahooSymbol);
            const [cmp, googleData] = await Promise.all([
                fetchCMP(stock.yahooSymbol, stock.staticCMP),
                fetchGoogleFinanceData(googleTicker),
            ]);
            const presentValue = stock.salePrice ? stock.salePrice * stock.quantity : (cmp || stock.staticCMP || 0) * stock.quantity;
            const gainLoss = presentValue - stock.investment;
            const gainLossPercentage = stock.investment ? (gainLoss / stock.investment) * 100 : 0;
            return {
                ...stock,
                symbol: stock.exchange,
                cmp,
                peRatio: googleData.peRatio,
                latestEarnings: googleData.latestEarnings,
                presentValue,
                gainLoss,
                gainLossPercentage,
            };
        }));
        const sectorSummaries = calculateSectorSummaries(portfolioData);
        res.json({
            portfolio: portfolioData,
            sectors: sectorSummaries,
        });
    }
    catch (error) {
        console.error('Error fetching portfolio data:', error.message);
        res.status(500).json({ error: 'Failed to fetch portfolio data' });
    }
});
// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        res.status(200).json({ status: 'OK' });
    }
    catch (error) {
        console.error('Health check failed:', error.message);
        res.status(500).json({ error: 'Health check failed' });
    }
});
// Start server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});
