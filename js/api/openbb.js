// OpenBB Data Platform layer: integrates with OpenBB Open Data Platform
// Provides access to financial data, analytics, and research tools
// https://openbb.co/

import { CONFIG } from './config.js';

const OPENBB_BASE = 'https://demo.openbb.co/api/v1';
const CACHE_KEY = 'coinvantageOpenBBCache';
CACHE_TTL = 60 * 15 * 1000; // 15 minutes

// Data types supported by OpenBB
export const DataType = {
  MARKET_DATA: 'market',
  CRYPTO: 'crypto',
  EQUITIES: 'equities',
  FOREX: 'forex',
  COMMODITIES: 'commodities',
  ECONOMIC: 'economic',
  ALTERNATIVE: 'alternative',
};

// Initialize OpenBB data layer
export async function initOpenBBLayer() {
  // Check if OpenBB is available (no API key required for demo endpoints)
  try {
    const response = await fetch(`${OPENBB_BASE}/health`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (response.ok) {
      const health = await response.json();
      return {
        available: true,
        version: health.version || 'unknown',
        status: health.status || 'unknown',
      };
    }
  } catch (err) {
    console.warn('OpenBB layer init warning:', err);
  }

  return { available: false, version: 'offline', status: 'unavailable' };
}

// Fetch market data from OpenBB
export async function fetchOpenBBData(symbol, type = DataType.CRYPTO, params = {}) {
  const cacheKey = `${symbol}:${type}:${JSON.stringify(params)}`;
  const cached = getOpenBBCache(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    let endpoint, queryParams;

    // Build endpoint based on data type
    switch (type) {
      case DataType.CRYPTO:
        endpoint = `/crypto/prices`;
        queryParams = {
          symbol,
          ...params,
        };
        break;

      case DataType.MARKET_DATA:
        endpoint = `/market/quote`;
        queryParams = {
          symbol,
          ...params,
        };
        break;

      case DataType.EQUITIES:
        endpoint = `/equities/quote`;
        queryParams = {
          symbol,
          ...params,
        };
        break;

      case DataType.FOREX:
        endpoint = `/forex/quote`;
        queryParams = {
          pair: symbol,
          ...params,
        };
        break;

      case DataType.COMMODITIES:
        endpoint = `/commodities/quote`;
        queryParams = {
          symbol,
          ...params,
        };
        break;

      default:
        throw new Error(`Unsupported OpenBB data type: ${type}`);
    }

    const response = await fetch(`${OPENBB_BASE}${endpoint}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-US',
      },
      // Add timeout and cache headers
    });

    if (!response.ok) {
      throw new Error(`OpenBB API error: ${response.status}`);
    }

    const data = await response.json();

    // Cache the result
    setOpenBBCache(cacheKey, data);

    return data;
  } catch (err) {
    console.error('OpenBB data fetch error:', err);
    return { error: err.message, fallback: true };
  }
}

// Get cached OpenBB data
function getOpenBBCache(key) {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;
    const cache = JSON.parse(cached);
    // Find the specific entry
    if (cache[key]) {
      return { data: cache[key], timestamp: cache.timestamps[key] || 0 };
    }
    // Return most recent if key not found
    if (cache.timestamps && Object.keys(cache.timestamps).length > 0) {
      const mostRecentKey = Object.keys(cache.timestamps).reduce(
        (a, b) => cache.timestamps[a] > cache.timestamps[b] ? a : b
      );
      return { data: cache.data[mostRecentKey], timestamp: cache.timestamps[mostRecentKey] };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Set OpenBB cache
function setOpenBBCache(key, data) {
  try {
    let cache = { data: {}, timestamps: {} };

    // Try to read existing cache
    const existing = localStorage.getItem(CACHE_KEY);
    if (existing) {
      try {
        cache = JSON.parse(existing);
      } catch (e) {
        // Corrupted cache, start fresh
      }
    }

    // Add new entry
    const timestamp = Date.now();
    cache.data[key] = data;
    cache.timestamps[key] = timestamp;

    // Keep only last 50 entries to avoid localStorage overflow
    const entries = Object.entries(cache.timestamps).sort(
      (a, b) => a[1] - b[1]
    );
    if (entries.length > 50) {
      const keysToRemove = entries.slice(0, entries.length - 50).map(([k]) => k);
      keysToRemove.forEach((k) => {
        delete cache.data[k];
        delete cache.timestamps[k];
      });
    }

    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // Silently ignore localStorage errors
  }
}

// Get OpenBB economic indicators
export async function fetchEconomicIndicators(symbol = 'US', indicators = []) {
  try {
    const defaultIndicators = ['gdp', 'cpi', 'unemployment', 'federal-funds-rate'];
    const targetIndicators = indicators.length > 0 ? indicators : defaultIndicators;

    const promises = targetIndicators.map(async (indicator) => {
      try {
        const response = await fetch(`${OPENBB_BASE}/economic/indicators/${indicator}?symbol=${symbol}`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });

        if (response.ok) {
          const data = await response.json();
          return { [indicator]: data };
        }
      } catch (err) {
        console.warn(`Failed to fetch ${indicator}:`, err);
      }
      return null;
    });

    const results = await Promise.all(promises);
    return results.reduce((acc, cur) => {
      if (cur) Object.assign(acc, cur);
      return acc;
    }, {});
  } catch (err) {
    console.error('Economic indicators error:', err);
    return {};
  }
}

// Get OpenBB sentiment data
export async function fetchSentimentData(symbol) {
  try {
    const response = await fetch(`${OPENBB_BASE}/sentiment/social?symbol=${symbol}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (err) {
    console.error('Sentiment data error:', err);
    return null;
  }
}

// Get OpenBB technical analysis
export async function fetchTechnicalAnalysis(symbol, period = '1d') {
  try {
    const response = await fetch(`${OPENBB_BASE}/technical/${period}?symbol=${symbol}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (err) {
    console.error('Technical analysis error:', err);
    return null;
  }
}