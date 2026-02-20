# Microsoft Rewards Automation Platform

## Production-Grade Automation with Intelligent Selector Evolution

A sophisticated automation platform designed for maximum resilience and long-term survivability. Features self-learning selector intelligence, behavioral anti-detection, and comprehensive failure recovery.

## Key Features

- **Intelligent Selector Evolution**: Self-learning system that adapts to UI changes automatically
- **Behavioral Anti-Detection**: Human-like interaction patterns with timing entropy
- **Failure Resilience**: Comprehensive recovery for 15+ failure scenarios  
- **Production Architecture**: 14 modular components with strict separation of concerns
- **Multi-Process Support**: Cluster-based parallel execution for multiple accounts
- **Dashboard Monitoring**: Optional read-only web dashboard for real-time tracking

## Quick Start

### Prerequisites

- Node.js 24.0.0 or higher
- Windows/Linux/macOS

### Installation

```bash
npm install
```

### Configuration

1. Copy example configuration:
   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` with your Microsoft account credentials

3. Adjust settings as needed:
   - `headless`: Run in headless mode (true/false)
   - `selectorLearning.enabled`: Enable intelligent selector evolution
   - `antiDetection.timingProfile`: Set to 'conservative', 'normal', or 'aggressive'

### Running

```bash
# Development mode (non-headless, verbose logging)
npm run dev

# Production mode
npm run build
npm run start

# With dashboard
npm run dashboard
```

## Architecture

The platform follows a layered architecture:

- **Control Layer**: Execution engine, configuration, logging
- **Intelligence Layer**: Selector bank, evolution, mutation, resolver
- **Context Layer**: Page detection, navigation, UI scanning
- **Task Layer**: State machine, parsers, handlers
- **Activity Layer**: Quiz, search, URL reward executors
- **Browser Layer**: Anti-detection, interaction primitives
- **Recovery Layer**: Error detection and recovery strategies

See [architecture.md](./brain/architecture.md) for detailed design.

## Key Components

### Selector Intelligence System

Automatically adapts to Microsoft UI changes:
- Stores multiple selector candidates per element
- Scores selectors based on success rate and performance
- Generates mutations when selectors fail
- Self-heals without manual intervention

### Anti-Detection Engine

Mimics human behavior:
- Variable timing with non-uniform distribution
- Realistic mouse movements (via ghost-cursor)
- Random hovers, scrolls, and pauses
- Decision latency simulation

### Error Recovery

Handles 15 failure modes:
- Collapsed UI sections
- Selector decay
- Lazy loading timeouts
- Headless detection
- Network errors
- Session expiration
- And more...

## Configuration Options

### Selector Learning

```json
{
  "selectorLearning": {
    "enabled": true,
    "persistencePath": "./selectors.db",
    "autoMutate": true,
    "trainingMode": false,
    "confidenceThreshold": 50
  }
}
```

### Anti-Detection

```json
{
  "antiDetection": {
    "timingProfile": "normal",
    "enableMouseMovement": true,
    "enableScrollVariation": true,
    "enableHoverBehavior": true
  }
}
```

### Recovery

```json
{
  "recovery": {
    "maxRetries": 3,
    "enableAutoRecovery": true,
    "fallbackToManual": false
  }
}
```

## Testing

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# Regression tests (UI drift)
npm run test:regression

# Coverage report
npm run test:coverage
```

## Development

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Auto-fix lint issues
npm run lint:fix
```

## Documentation

- [Implementation Plan](./brain/implementation_plan.md) - Detailed component design
- [Architecture](./brain/architecture.md) - System design and interactions
- [Failure Analysis](./brain/failure_analysis.md) - Red team failure matrix
- [Task Breakdown](./brain/task.md) - Implementation roadmap

## Safety & Ethics

This platform is designed for personal use automation of Microsoft Rewards tasks. Users are responsible for:
- Complying with Microsoft  Terms of Service
- Using the platform ethically
- Not violating any laws or regulations

**Disclaimer**: This project is for educational purposes. The authors are not responsible for any account bans or violations resulting from use of this software.

## License

[MIT License](./LICENSE)

## Credits

This project builds upon the foundational work and concepts from:
- **[TheNetsky/microsoft-rewards-script](https://github.com/TheNetsky/microsoft-rewards-script)**: Provided inspiration for the execution engine, search strategies, and baseline anti-detection patterns.
- **[LightZirconite/Microsoft-Rewards-Bot](https://github.com/LightZirconite/Microsoft-Rewards-Bot)**: Provided inspiration for the overall architecture and dashboard visualization concepts.

Rewritten from scratch with advanced selector intelligence, behavioral modeling, and production-grade architecture.

---

**Status**: 🚧 **BETA**

**Note**: This project is still in active development (Beta). Some features may be unstable or subject to change.
