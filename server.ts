import express, { Request, Response } from 'express';
import cors from 'cors';
import yahooFinance from 'yahoo-finance2';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Redis from 'ioredis';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { portfolio, PortfolioResponse} from './data';

// Suppress Yahoo Finance survey notice
yahooFinance.suppressNotices(['yahooSurvey']);

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Redis client setup
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiter to prevent API abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
});
app.use(limiter);


// Cache keys
const CACHE_TTL = 60; // Cache for 60 seconds

// Check if Indian market is open (9:15 AM to 3:30 PM IST, Mon-Fri)
function isMarketOpen(): boolean {
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
function convertToGoogleFinanceTicker(yahooSymbol: string): string {
  // Remove '.NS' or '.BO' suffix and append ':NSE' or ':BSE'
  const exchange = yahooSymbol.endsWith('.NS') ? 'NSE' : yahooSymbol.endsWith('.BO') ? 'BSE' : 'NSE';
  const ticker = yahooSymbol.replace(/\.NS$|\.BO$/, '');
  return `${ticker}:${exchange}`;
}

// Fetch CMP from Yahoo Finance
async function fetchCMP(symbol: string, staticCMP: number | null): Promise<number | null> {
  const cacheKey = `cmp:${symbol}`;
  const cachedCMP = await redis.get(cacheKey);
  if (cachedCMP) return parseFloat(cachedCMP);

  // if (!isMarketOpen()) {
  //   console.warn(`Market is closed. Using static CMP (${staticCMP}) for ${symbol}`);
  //   return staticCMP;
  // }

  try {
    const quote = await yahooFinance.quote(symbol);
    if (!quote || !quote.regularMarketPrice) {
      console.warn(`No CMP data for ${symbol}. Using static CMP (${staticCMP})`);
      return staticCMP;
    }
    const cmp = quote.regularMarketPrice;
    await redis.set(cacheKey, cmp, 'EX', CACHE_TTL);
    console.log('Fetching CMP from Yahoo Finance:', symbol, 'Result:', cmp);
    return cmp;
  } catch (error: any) {
    console.error(`Error fetching CMP for ${symbol}:`, error.message);
    console.warn(`Using static CMP (${staticCMP}) for ${symbol}`);
    return staticCMP;
  }
}

// Fetch P/E Ratio and EPS from Google Finance
async function fetchGoogleFinanceData(ticker: string): Promise<{ peRatio: string | null; latestEarnings: string | null }> {
  const cacheKey = `googleFinance:${ticker}`;
  const cachedData = await redis.get(cacheKey);
  if (cachedData) return JSON.parse(cachedData);

  try {
    const url = `https://www.google.com/finance/quote/${ticker}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);

    let peRatio: string | null = 'N/A';
    let latestEarnings: string | null = 'N/A';

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
    await redis.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL);
    console.log(`Fetched Google Finance data for ${ticker}:`, data);
    return data;
  } catch (error: any) {
    console.error(`Error fetching Google Finance data for ${ticker}:`, error.message);
    return { peRatio: 'Error', latestEarnings: 'Error' };
  }
}

// Calculate sector summaries
function calculateSectorSummaries(portfolioData: PortfolioResponse[]) {
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
  }, {} as Record<string, {
    totalInvestment: number;
    totalPresentValue: number;
    totalGainLoss: number;
    totalMarketCap: number;
    totalRevenueTTM: number;
    totalEbitdaTTM: number;
    totalPat: number;
  }>);

  return sectors;
}

// API endpoint to get portfolio data
app.get('/api/portfolio', async (req: Request, res: Response) => {
  try {
    const portfolioData: PortfolioResponse[] = await Promise.all(
      portfolio.map(async (stock) => {
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
      })
    );

    const sectorSummaries = calculateSectorSummaries(portfolioData);

    res.json({
      portfolio: portfolioData,
      sectors: sectorSummaries,
    });
  } catch (error: any) {
    console.error('Error fetching portfolio data:', error.message);
    res.status(500).json({ error: 'Failed to fetch portfolio data' });
  }
});

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
  try {
    res.status(200).json({ status: 'OK' });
  } catch (error: any) {
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