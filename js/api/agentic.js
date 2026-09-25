// Agentic framework: event-driven task orchestration for trading operations
// Provides a paperclip-inspired agent framework that coordinates multiple
// trading agents (market scanner, portfolio rebalancer, risk manager, etc.)

import { CONFIG } from '../config.js';
import { $, $$ , toast } from '../ui.js';

const AGENT_KEY = 'coinvantageAgents';
const TASK_LOG_KEY = 'coinvantageTaskLog';
const MAX_TASKS = 100;

// Base agent class
class BaseAgent {
  constructor(name, priority = 'normal') {
    this.name = name;
    this.priority = priority;
    this.status = 'idle'; // idle, running, completed, failed
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.lastRun = null;
    this.metrics = {
      signalsGenerated: 0,
      tradesExecuted: 0,
      riskEvents: 0,
      accuracy: 0.0,
    };
  }

  getStatus() {
    return {
      name: this.name,
      status: this.status,
      priority: this.priority,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      lastRun: this.lastRun,
      metrics: { ...this.metrics },
    };
  }

  async run(context) {
    // Subclasses must implement this
    throw new Error('run() must be implemented by subclass');
  }

  recordSignal(signalType, details = {}) {
    this.metrics.signalsGenerated++;
    toast(`Signal: ${signalType}`, 'info');
    this.logTask('signal', signalType, details);
  }

  recordTrade(tradeType, result, details = {}) {
    this.metrics.tradesExecuted++;
    const status = result.profit >= 0 ? 'up' : 'down';
    toast(`${tradeType} — ${result.pnlPct}% ${status}`, status);
    this.logTask('trade', tradeType, { ...result, status });
  }

  recordRiskEvent(event, details = {}) {
    this.metrics.riskEvents++;
    toast(`Risk: ${event}`, 'down');
    this.logTask('risk', event, details);
  }

  logTask(type, detail, data = {}) {
    const logEntry = {
      id: Date.now() + Math.random(),
      type,
      detail,
      data,
      timestamp: new Date().toISOString(),
    };

    let log = [];
    try {
      const stored = localStorage.getItem(TASK_LOG_KEY);
      if (stored) log = JSON.parse(stored);
    } catch (e) {}

    log.unshift(logEntry);

    // Keep only last MAX_TASKS entries
    if (log.length > MAX_TASKS) log = log.slice(0, MAX_TASKS);

    try {
      localStorage.setItem(TASK_LOG_KEY, JSON.stringify(log));
    } catch (e) {}
  }

  getTaskLog() {
    let log = [];
    try {
      const stored = localStorage.getItem(TASK_LOG_KEY);
      if (stored) log = JSON.parse(stored);
    } catch (e) {}
    return log.slice(0, 20); // Return last 20 entries
  }
}

// Market Scanner Agent
class MarketScannerAgent extends BaseAgent {
  constructor() {
    super('MarketScanner', 'high');
  }

  async run(context = {}) {
    this.status = 'running';
    this.lastRun = new Date().toISOString();

    try {
      const markers = await this.scanMarkets(context);
      this.recordSignal('market_scan', { markers });
      this.status = 'completed';
      return markers;
    } catch (err) {
      this.status = 'failed';
      this.recordRiskEvent('market scan failed: ' + err.message);
      throw err;
    }
  }

  async scanMarkets(context) {
    // Scan for trading opportunities across configured universes
    const universe = context.universe || CONFIG.DEFAULT_UNIVERSE || ['BTC', 'ETH', 'ADA', 'SOL'];
    const opportunities = [];

    for (const symbol of universe) {
      try {
        // Get market data
        const marketData = await this.getMarketData(symbol);
        if (!marketData) continue;

        // Check for patterns/opportunities
        const opportunitiesForSymbol = this.checkPatterns(symbol, marketData);
        opportunities.push(...opportunitiesForSymbol);
      } catch (err) {
        console.warn(`Failed to scan ${symbol}:`, err);
      }
    }

    // Sort by score (highest first)
    opportunities.sort((a, b) => b.score - a.score);

    return opportunities.slice(0, 20); // Return top 20
  }

  async getMarketData(symbol) {
    // Fetch market data from configured APIs
    const rest = CONFIG.BINANCE_REST[0];
    try {
      const response = await fetch(`${rest}/api/v3/ticker/24h?symbol=${symbol.toUpperCase()}USDT`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return {
        symbol,
        price: parseFloat(data.lastPrice),
        change24h: parseFloat(data.priceChangePercent),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        volume24h: parseFloat(data.volume),
      };
    } catch (err) {
      console.warn(`Failed to fetch market data for ${symbol}:`, err);
      return null;
    }
  }

  checkPatterns(symbol, marketData) {
    // Simple pattern detection for opportunities
    const opportunities = [];
    const { price, change24h, volume24h } = marketData;

    // Momentum pattern: strong positive momentum + high volume
    if (change24h && change24h > 5 && volume24h > 1000000) {
      opportunities.push({
        symbol,
        type: 'momentum',
        score: change24h,
        description: `${symbol} showing strong ${change24h}% momentum with high volume`,
      });
    }

    // Reversal pattern: extreme move + mean reversion signal
    if (change24h && Math.abs(change24h) > 10) {
      opportunities.push({
        symbol,
        type: 'reversal',
        score: -Math.abs(change24h),
        description: `${symbol} showing extreme ${change24h > 0 ? 'gain' : 'loss'} — potential reversal`,
      });
    }

    return opportunities;
  }
}

// Portfolio Rebalancer Agent
class PortfolioRebalancerAgent extends BaseAgent {
  constructor() {
    super('PortfolioRebalancer', 'medium');
  }

  async run(context = {}) {
    this.status = 'running';
    this.lastRun = new Date().toISOString();

    try {
      const rebalancing = await this.rebalance(context);
      this.recordSignal('rebalance', { rebalancing });
      this.status = 'completed';
      return rebalancing;
    } catch (err) {
      this.status = 'failed';
      this.recordRiskEvent('rebalancing failed: ' + err.message);
      throw err;
    }
  }

  async rebalance(context) {
    const portfolio = context.portfolio || {};
    const targetAllocation = context.targetAllocation || {};

    if (!portfolio || !Object.keys(portfolio).length) {
      return { action: 'no_portfolio', reason: 'No portfolio data' };
    }

    const currentValues = {};
    let totalValue = 0;

    // Get current values
    for (const [symbol, pos] of Object.entries(portfolio)) {
      const price = context.priceFeed ? context.priceFeed[symbol] : 0;
      currentValues[symbol] = price * pos.quantity;
      totalValue += currentValues[symbol];
    }

    if (totalValue === 0) {
      return { action: 'no_value', reason: 'Portfolio has no value' };
    }

    // Calculate target quantities
    const rebalancing = {
      action: 'rebalance',
      current: { ...currentValues },
      totalValue,
      adjustments: [],
    };

    // Compare with target allocation
    for (const [symbol, targetPct] of Object.entries(targetAllocation)) {
      const currentPct = totalValue > 0 ? currentValues[symbol] / totalValue : 0;
      const targetValue = totalValue * targetPct;
      const adjustment = targetValue - currentValues[symbol];

      if (Math.abs(adjustment) > totalValue * 0.05) { // 5% threshold
        rebalancing.adjustments.push({
          symbol,
          currentPct: (currentPct * 100).toFixed(2),
          targetPct: (targetPct * 100).toFixed(2),
          adjustment,
          action: adjustment > 0 ? 'buy' : 'sell',
          adjustmentPct: (Math.abs(adjustment) / totalValue * 100).toFixed(2),
        });
      }
    }

    // Sort adjustments by absolute value (largest first)
    rebalancing.adjustments.sort((a, b) => Math.abs(b.adjustment) - Math.abs(a.adjustment));

    return rebalancing;
  }
}

// Risk Manager Agent
class RiskManagerAgent extends BaseAgent {
  constructor() {
    super('RiskManager', 'critical');
  }

  async run(context = {}) {
    this.status = 'running';
    this.lastRun = new Date().toISOString();

    try {
      const riskAssessment = await this.assessRisk(context);
      this.status = 'completed';
      return riskAssessment;
    } catch (err) {
      this.status = 'failed';
      this.recordRiskEvent('risk assessment failed: ' + err.message);
      throw err;
    }
  }

  async assessRisk(context) {
    const portfolio = context.portfolio || {};
    const marketData = context.marketData || {};

    if (!portfolio || !Object.keys(portfolio).length) {
      return { riskLevel: 'none', score: 0, events: [] };
    }

    const events = [];
    let riskScore = 0; // 0-100 scale

    // Check concentration risk
    const positions = Object.values(portfolio);
    const totalExposure = positions.reduce((sum, pos) => sum + pos.notional, 0);

    if (totalExposure > 0) {
      // Top-heavy concentration
      const topPosition = Math.max(...positions.map(p => p.notional), 0);
      const concentration = topPosition / totalExposure;

      if (concentration > 0.5) {
        events.push({
          type: 'concentration',
          severity: 'high',
          message: `Top position represents ${(concentration * 100).toFixed(1)}% of portfolio`,
        });
        riskScore += 25;
      }

      // Check for margin/leverage
      for (const pos of positions) {
        if (pos.leverage && pos.leverage > 3) {
          events.push({
            type: 'leverage',
            severity: 'medium',
            message: `${pos.symbol} using ${pos.leverage}x leverage`,
          });
          riskScore += 10;
        }
      }
    }

    // Check market risk
    if (marketData.fearGreed !== undefined) {
      if (marketData.fearGreed < 25) {
        events.push({
          type: 'sentiment',
          severity: 'high',
          message: 'Extreme fear in market — heightened volatility expected',
        });
        riskScore += 15;
      } else if (marketData.fearGreed > 75) {
        events.push({
          type: 'sentiment',
          severity: 'medium',
          message: 'Extreme greed in market — potential for correction',
        });
        riskScore += 10;
      }
    }

    // Determine overall risk level
    let riskLevel = 'low';
    if (riskScore >= 50) riskLevel = 'critical';
    else if (riskScore >= 30) riskLevel = 'high';
    else if (riskScore >= 15) riskLevel = 'medium';

    return {
      riskLevel,
      score: riskScore,
      events,
      timestamp: new Date().toISOString(),
    };
  }
}

// Agent framework initialization and management
export function initAgenticFramework() {
  // Initialize default agents
  const agents = {
    marketScanner: new MarketScannerAgent(),
    portfolioRebalancer: new PortfolioRebalancerAgent(),
    riskManager: new RiskManagerAgent(),
  };

  // Store in localStorage
  try {
    localStorage.setItem(AGENT_KEY, JSON.stringify({
      agents: Object.fromEntries(
        Object.entries(agents).map(([name, agent]) => [name, {
          name: agent.name,
          priority: agent.priority,
          status: agent.status,
          tasksCompleted: agent.tasksCompleted,
          tasksFailed: agent.tasksFailed,
          lastRun: agent.lastRun,
          metrics: agent.metrics,
        }])
      ),
      created: new Date().toISOString(),
    }));
  } catch (e) {}

  return agents;
}

export function createAgent(agentType) {
  const agents = {
    marketScanner: new (require('./api/agentic.js').MarketScannerAgent)(),
    portfolioRebalancer: new (require('./api/agentic.js').PortfolioRebalancerAgent)(),
    riskManager: new (require('./api/agentic.js').RiskManagerAgent)(),
  };

  if (agents[agentType]) {
    return new agents[agentType]();
  }
  throw new Error(`Unknown agent type: ${agentType}`);
}

export async function runAgentTask(agentName, task, context = {}) {
  const agents = await loadAgents();
  const agent = agents[agentName];

  if (!agent) {
    throw new Error(`Agent ${agentName} not found`);
  }

  agent.status = 'running';
  agent.lastRun = new Date().toISOString();

  try {
    const result = await agent.run(context);
    agent.status = 'completed';
    agent.tasksCompleted++;
    toast(`Agent ${agentName} completed task: ${task}`, 'up');
    return result;
  } catch (err) {
    agent.status = 'failed';
    agent.tasksFailed++;
    toast(`Agent ${agentName} failed: ${err.message}`, 'down');
    throw err;
  } finally {
    // Save agent state
    try {
      const stored = localStorage.getItem(AGENT_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        data.agents[agentName] = {
          name: agent.name,
          priority: agent.priority,
          status: agent.status,
          tasksCompleted: agent.tasksCompleted,
          tasksFailed: agent.tasksFailed,
          lastRun: agent.lastRun,
          metrics: agent.metrics,
        };
        localStorage.setItem(AGENT_KEY, JSON.stringify(data));
      }
    } catch (e) {}
  }
}

async function loadAgents() {
  try {
    const stored = localStorage.getItem(AGENT_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      return data.agents || {};
    }
  } catch (e) {}
  return await initAgenticFramework();
}