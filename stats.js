// stats.js - StatsEngine for Ant Colony Simulation

export class StatsEngine {
    constructor() {
        this.killMatrix = {}; // Attacker ID -> Victim ID -> count
        this.deathCounts = {}; // Colony ID -> count
        this.histories = {}; // Colony ID -> { population: [], food: [] }
        this.predictions = [];
        this.narrativeQueue = [];
        this.lastPredictionTime = 0;
        this.lastHistorySampleTime = 0;
        
        // Cooldowns to prevent spamming narrative events (ColonyID_EventType -> timestamp)
        this.narrativeCooldowns = {};

        // Kill feed: rolling log of recent kill events [{time, attackerId, victimId, count}]
        this.killFeed = [];
        this.MAX_KILL_FEED = 20;

        // Battle intensity: rolling window of kills-per-second
        this.recentKillTimes = []; // timestamps of recent kills
        this.battleIntensity = 0; // 0-100
    }

    initColonies(colonies) {
        colonies.forEach(c => {
            const colId = c.colonyId;
            this.killMatrix[colId] = {};
            colonies.forEach(other => {
                if (other.colonyId !== colId) {
                    this.killMatrix[colId][other.colonyId] = 0;
                }
            });
            this.deathCounts[colId] = 0;
            this.histories[colId] = {
                population: [],
                food: []
            };
        });
    }

    recordKill(attackerColonyId, victimColonyId) {
        if (attackerColonyId !== undefined && victimColonyId !== undefined && attackerColonyId !== victimColonyId) {
            if (!this.killMatrix[attackerColonyId]) {
                this.killMatrix[attackerColonyId] = {};
            }
            this.killMatrix[attackerColonyId][victimColonyId] = (this.killMatrix[attackerColonyId][victimColonyId] || 0) + 1;
            this.deathCounts[victimColonyId] = (this.deathCounts[victimColonyId] || 0) + 1;

            // Track for battle intensity and last kill times
            const now = Date.now();
            this.recentKillTimes.push(now);
            this.recentKillTimes = this.recentKillTimes.filter(t => now - t < 10000);

            this.lastKillTime = this.lastKillTime || {};
            this.lastKillTime[`${attackerColonyId}_${victimColonyId}`] = now;

            // Kill feed: merge with last entry if same attacker/victim within 3 seconds
            const last = this.killFeed[this.killFeed.length - 1];
            if (last && last.attackerId === attackerColonyId && last.victimId === victimColonyId && now - last.time < 3000) {
                last.count++;
                last.time = now;
            } else {
                this.killFeed.push({ time: now, attackerId: attackerColonyId, victimId: victimColonyId, count: 1 });
                if (this.killFeed.length > this.MAX_KILL_FEED) this.killFeed.shift();
            }
        }
    }

    pushEvent(type, text, cooldownKey = null, cooldownDuration = 10000) {
        const now = Date.now();
        if (cooldownKey) {
            if (this.narrativeCooldowns[cooldownKey] && now - this.narrativeCooldowns[cooldownKey] < cooldownDuration) {
                return; // Suppress spam
            }
            this.narrativeCooldowns[cooldownKey] = now;
        }

        this.narrativeQueue.push({
            id: Math.random().toString(36).substr(2, 9),
            type,
            text,
            time: now
        });
        
        // Limit queue size
        if (this.narrativeQueue.length > 50) {
            this.narrativeQueue.shift();
        }
    }

    flushEvents() {
        const events = [...this.narrativeQueue];
        this.narrativeQueue = [];
        return events;
    }

    update(colonies, terrain, time) {
        const now = Date.now();

        // 1. Record Rolling Histories every 1s
        if (now - this.lastHistorySampleTime > 1000) {
            colonies.forEach(c => {
                const h = this.histories[c.colonyId];
                if (h) {
                    h.population.push(c.ants.length);
                    h.food.push(c.foodCollected);
                    if (h.population.length > 30) h.population.shift();
                    if (h.food.length > 30) h.food.shift();
                }
            });
            this.lastHistorySampleTime = now;
        }

        // 1b. Update battle intensity every frame (kills in last 10s, scaled 0-100)
        this.recentKillTimes = this.recentKillTimes.filter(t => now - t < 10000);
        // Scale: 0 kills = 0, 30+ kills/10s = 100
        this.battleIntensity = Math.min(100, (this.recentKillTimes.length / 30) * 100);

        // 2. Perform heavier computations (Risk, Predictions) every 3 seconds
        if (now - this.lastPredictionTime > 3000) {
            this.computeMetrics(colonies, terrain);
            this.lastPredictionTime = now;
        }
    }

    updateDiplomacy(colonies) {
        this.lastKillTime = this.lastKillTime || {};
        const now = Date.now();

        colonies.forEach(c => {
            if (!c.stances) c.stances = {};
            
            colonies.forEach(other => {
                if (c.colonyId === other.colonyId) return;

                // Default stance is Neutral
                if (!c.stances[other.colonyId]) {
                    c.stances[other.colonyId] = 'Neutral';
                }

                const stanceKey = `${other.colonyId}_${c.colonyId}`; // other kills c
                const lastKill = this.lastKillTime[stanceKey] || 0;
                const timeSinceKill = now - lastKill;
                const otherKillsOfC = (this.killMatrix[other.colonyId] && this.killMatrix[other.colonyId][c.colonyId]) || 0;

                const p = c.personality || 'dove';

                if (p === 'hawk') {
                    c.stances[other.colonyId] = 'Hostile';
                } else if (p === 'grudger') {
                    if (otherKillsOfC > 0) {
                        if (c.stances[other.colonyId] !== 'Hostile') {
                            c.stances[other.colonyId] = 'Hostile';
                            this.pushEvent('diplomacy', `😡 Retaliation! Grudger ${this.getColName(c.colonyId)} declared permanent war on ${this.getColName(other.colonyId)}!`, `${c.colonyId}_grudge_${other.colonyId}`, 15000);
                        }
                    }
                } else if (p === 'bully') {
                    const ourPop = c.ants.filter(a => a.hp > 0).length;
                    const theirPop = other.ants.filter(a => a.hp > 0).length;
                    if (theirPop > 0 && ourPop > theirPop * 1.2) {
                        if (c.stances[other.colonyId] !== 'Hostile') {
                            c.stances[other.colonyId] = 'Hostile';
                            this.pushEvent('diplomacy', `⚔️ Bully ${this.getColName(c.colonyId)} targets weaker ${this.getColName(other.colonyId)} Colony!`, `${c.colonyId}_bully_${other.colonyId}`, 15000);
                        }
                    } else {
                        if (otherKillsOfC >= 3 && lastKill > 0 && timeSinceKill < 15000) {
                            c.stances[other.colonyId] = 'Hostile';
                        } else if (timeSinceKill > 15000) {
                            c.stances[other.colonyId] = 'Neutral';
                        }
                    }
                } else {
                    // Dove
                    if (otherKillsOfC >= 3 && lastKill > 0 && timeSinceKill < 15000) {
                        if (c.stances[other.colonyId] !== 'Hostile') {
                            c.stances[other.colonyId] = 'Hostile';
                            this.pushEvent('diplomacy', `🛡️ Peaceful ${this.getColName(c.colonyId)} forced into Hostility by aggressive ${this.getColName(other.colonyId)}!`, `${c.colonyId}_dove_war_${other.colonyId}`, 15000);
                        }
                    } else if (timeSinceKill > 15000 && c.stances[other.colonyId] === 'Hostile') {
                        c.stances[other.colonyId] = 'Neutral';
                        this.pushEvent('diplomacy', `🕊️ Conflict cooled down. ${this.getColName(c.colonyId)} returns to Neutral with ${this.getColName(other.colonyId)}.`, `${c.colonyId}_dove_peace_${other.colonyId}`, 15000);
                    }
                }
            });
        });
    }

    getColName(id) {
        const names = ["Green", "Blue", "Gold", "Purple", "Teal", "Lime"];
        return names[id] ? `${names[id]}` : `Colony ${id}`;
    }

    computeMetrics(colonies, terrain) {
        this.updateDiplomacy(colonies);
        const predictionsList = [];

        colonies.forEach(c => {
            const history = this.histories[c.colonyId];
            if (!history || history.population.length < 2) return;

            // Compute population trend (slope over last 10 samples)
            const popSamples = history.population;
            const recentSamples = popSamples.slice(-10);
            let slope = 0;
            if (recentSamples.length >= 2) {
                let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
                const n = recentSamples.length;
                for (let i = 0; i < n; i++) {
                    sumX += i;
                    sumY += recentSamples[i];
                    sumXY += i * recentSamples[i];
                    sumXX += i * i;
                }
                slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
            }

            // Estimate HP distribution
            let hpBuckets = [0, 0, 0, 0]; // 0-25, 26-50, 51-75, 76-100
            let totalHp = 0;
            let lowHpCount = 0;
            const totalAnts = c.ants.length;
            c.ants.forEach(ant => {
                const hp = ant.hp || 0;
                totalHp += hp;
                if (hp < 30) lowHpCount++;
                if (hp <= 25) hpBuckets[0]++;
                else if (hp <= 50) hpBuckets[1]++;
                else if (hp <= 75) hpBuckets[2]++;
                else hpBuckets[3]++;
            });
            const meanHp = totalAnts > 0 ? totalHp / totalAnts : 0;
            const lowHpRatio = totalAnts > 0 ? lowHpCount / totalAnts : 0;

            // Combat dynamics
            let combatCount = 0;
            c.ants.forEach(ant => {
                if (ant.state === 'combat' || ant.combatTarget) combatCount++;
            });
            const aggressionIndex = totalAnts > 0 ? combatCount / totalAnts : 0;

            // Nearest threat
            let minThreatDist = 9999;
            let targetColonyThreat = null;
            colonies.forEach(other => {
                if (other.colonyId !== c.colonyId) {
                    other.ants.forEach(oAnt => {
                        const dx = oAnt.x - c.nestX;
                        const dz = oAnt.z - c.nestZ;
                        const dist = Math.sqrt(dx * dx + dz * dz);
                        if (dist < minThreatDist) {
                            minThreatDist = dist;
                            targetColonyThreat = other.colonyId;
                        }
                    });
                }
            });

            // Extinction Risk Score
            let risk = 0;
            const initialPopulation = 50; // default setup initial population approximation
            if (totalAnts < initialPopulation * 0.25) risk += 40;
            else if (totalAnts < initialPopulation * 0.5) risk += 20;

            if (slope < -0.5) risk += 20;
            if (minThreatDist < 15) risk += 20;
            if (lowHpRatio > 0.4) risk += 10;
            
            const K = this.killMatrix[c.colonyId];
            const kills = K ? Object.values(K).reduce((a, b) => a + b, 0) : 0;
            const deaths = this.deathCounts[c.colonyId] || 0;
            const kd = deaths > 0 ? kills / deaths : kills;
            if (kd < 0.4 && deaths > 0) risk += 10;

            risk = Math.min(100, risk);
            c.extinctionRisk = risk;
            c.populationSlope = slope;
            c.meanHp = meanHp;
            c.hpBuckets = hpBuckets;
            c.aggressionIndex = aggressionIndex;
            c.nearestThreatDist = minThreatDist;
            c.kdRatio = kd;

            // Resolve friendly colony name helper
            const getColName = (id) => {
                const names = ["Green", "Blue", "Gold", "Purple", "Teal", "Lime"];
                return names[id] ? `${names[id]} Colony` : `Colony ${id}`;
            };

            // Resolve raw color name helper
            const getColColorName = (id) => {
                const names = ["Green", "Blue", "Gold", "Purple", "Teal", "Lime"];
                return names[id] ? names[id] : `Colony ${id}`;
            };

            // Trigger narrative event alerts for high risk or threat
            if (risk >= 70) {
                this.pushEvent('risk', `⚠️ ${getColName(c.colonyId)} is in critical danger of extinction!`, `${c.colonyId}_high_risk`, 20000);
            }
            if (minThreatDist < 10 && totalAnts > 0) {
                this.pushEvent('threat', `🚨 Enemy detected near ${getColName(c.colonyId)} Nest! (${Math.round(minThreatDist)} units away)`, `${c.colonyId}_threat_near`, 15000);
            }

            // Generate narrative predictions
            if (risk > 60 && totalAnts > 0 && slope < 0) {
                const secondsToExtinction = Math.ceil(totalAnts / Math.abs(slope));
                predictionsList.push({
                    icon: '💀',
                    title: `${getColColorName(c.colonyId)} Extinction Imminent`,
                    desc: `At current decline rate of ${Math.abs(slope).toFixed(1)} ants/s, population is predicted to hit zero in ${secondsToExtinction}s.`
                });
            } else if (slope < -0.3 && totalAnts > 5) {
                const projectedPopulation = Math.max(0, Math.round(totalAnts + slope * 30));
                predictionsList.push({
                    icon: '⚠️',
                    title: `${getColColorName(c.colonyId)} Severe Attrition`,
                    desc: `High combat mortality predicts population will drop from ${totalAnts} to ${projectedPopulation} within the next 30s.`
                });
            }

            if (aggressionIndex > 0.5 && totalAnts > 5) {
                predictionsList.push({
                    icon: '⚔️',
                    title: `${getColColorName(c.colonyId)} Resource Lock`,
                    desc: `With ${Math.round(aggressionIndex * 100)}% of workers engaged in combat, food collection is predicted to stall over the next 45s.`
                });
            }

            if (minThreatDist < 18 && totalAnts > 0) {
                const etaSeconds = Math.max(5, Math.round(minThreatDist / 1.5));
                predictionsList.push({
                    icon: '🚨',
                    title: `Nest Breach Predicted for ${getColColorName(c.colonyId)}`,
                    desc: `Enemies approaching nest at ${Math.round(minThreatDist)}m. Intruder breach expected in approximately ${etaSeconds}s.`
                });
            }

            // Food milestone prediction
            const foodSamples = history.food;
            const recentFoodSamples = foodSamples.slice(-10);
            let foodSlope = 0;
            if (recentFoodSamples.length >= 2) {
                let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
                const n = recentFoodSamples.length;
                for (let i = 0; i < n; i++) {
                    sumX += i;
                    sumY += recentFoodSamples[i];
                    sumXY += i * recentFoodSamples[i];
                    sumXX += i * i;
                }
                foodSlope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
            }
            if (foodSlope > 0.05) {
                const currentFood = c.foodCollected;
                const milestone = Math.ceil((currentFood + 15) / 50) * 50;
                const secondsToMilestone = Math.ceil((milestone - currentFood) / foodSlope);
                if (secondsToMilestone > 0 && secondsToMilestone < 300) {
                    predictionsList.push({
                        icon: '📈',
                        title: `${getColColorName(c.colonyId)} Expansion Forecast`,
                        desc: `Gathering velocity predicts colony will secure the ${milestone} food milestone in ${secondsToMilestone}s.`
                    });
                }
            }
        });

        // ── Resolve friendly colony name helper for global lists ──
        const getColNameGlobal = (id) => {
            const names = ["Green", "Blue", "Gold", "Purple", "Teal", "Lime"];
            return names[id] ? names[id] : `Colony ${id}`;
        };

        // ── CALCULATE DYNAMIC WIN PROBABILITIES ──
        let totalScore = 0;
        const scores = {};
        colonies.forEach(c => {
            const antsCount = c.ants.length;
            const food = c.foodCollected;
            const hp = c.meanHp || 0;
            const rsk = c.extinctionRisk || 0;
            
            // Score weightings: population size, food stored, health profile, and extinction risk
            let score = (antsCount * 2.0) + (food * 3.0) + (hp * 0.4) - (rsk * 1.5);
            score = Math.max(5, score); // minimum score of 5
            scores[c.colonyId] = score;
            totalScore += score;
        });

        const winProbs = {};
        colonies.forEach(c => {
            winProbs[c.colonyId] = totalScore > 0 ? Math.round((scores[c.colonyId] / totalScore) * 100) : Math.round(100 / colonies.length);
        });

        // Adjust probabilities so they sum to 100%
        let probSum = 0;
        colonies.forEach(c => { probSum += winProbs[c.colonyId]; });
        if (probSum > 0 && probSum !== 100 && colonies.length > 0) {
            const diff = 100 - probSum;
            winProbs[colonies[0].colonyId] += diff;
        }

        // Win Probability prediction (placed at the top for maximum visibility)
        const probDesc = colonies.map(c => `${getColNameGlobal(c.colonyId)}: ${winProbs[c.colonyId]}%`).join(' | ');
        const topPredictions = [];
        
        topPredictions.push({
            icon: '🔮',
            title: 'Win Probability Forecast',
            desc: `Current metrics model win odds at: ${probDesc}. Calculations incorporate population size, food supply, health levels, and environmental risks.`
        });

        // ── GAME THEORY STANCE ANALYSIS ──
        for (let i = 0; i < colonies.length; i++) {
            for (let j = i + 1; j < colonies.length; j++) {
                const cA = colonies[i];
                const cB = colonies[j];
                const nameA = getColNameGlobal(cA.colonyId);
                const nameB = getColNameGlobal(cB.colonyId);
                const stanceA = cA.stances[cB.colonyId] || 'Neutral';
                const stanceB = cB.stances[cA.colonyId] || 'Neutral';
                const persA = cA.personality || 'dove';
                const persB = cB.personality || 'dove';

                if (stanceA === 'Allied' && stanceB === 'Allied') {
                    topPredictions.push({
                        icon: '🤝',
                        title: `Coalition: ${nameA} & ${nameB}`,
                        desc: `Mutual alliance is maintaining zero-casualty coexistence. Cooperative harvesting increases joint resource efficiency by ~30%.`
                    });
                } else if (stanceA === 'Hostile' && stanceB === 'Hostile') {
                    topPredictions.push({
                        icon: '⚔️',
                        title: `Mutual Attrition: ${nameA} vs ${nameB}`,
                        desc: `Both colonies are locked in mutual hostility. Heavy attrition is projected to reduce growth rates of both sides by 45%.`
                    });
                } else if (persA === 'hawk' && persB === 'dove' && stanceA === 'Hostile') {
                    topPredictions.push({
                        icon: '🦅',
                        title: `Asymmetric Exploitation: ${nameA} on ${nameB}`,
                        desc: `Hawk ${nameA} is actively exploiting Dove ${nameB}. Without defensive retaliation, ${nameB} is projected to lose 35% of its workforce.`
                    });
                } else if (persA === 'bully' && persB === 'dove' && stanceA === 'Hostile') {
                    topPredictions.push({
                        icon: '🐺',
                        title: `Predatory Bullying: ${nameA} targeting ${nameB}`,
                        desc: `Bully ${nameA} is hunting workers from Dove ${nameB}. Conflict is expected to persist unless ${nameB} mounts a retaliatory defense.`
                    });
                } else if (persA === 'grudger' && stanceA === 'Hostile' && cA.ants.length > 5) {
                    topPredictions.push({
                        icon: '⚖️',
                        title: `Retributive Retaliation: ${nameA}`,
                        desc: `Tit-for-Tat ${nameA} has triggered defensive retaliation against ${nameB}. The local border war will escalate until cooperative behavior is restored.`
                    });
                }
            }
        }

        // Combine lists, prioritizing dynamic forecast and game theory insights
        const finalPredictions = [...topPredictions, ...predictionsList];

        // Add default prediction if empty
        if (finalPredictions.length === 0) {
            finalPredictions.push({
                icon: '⏳',
                title: 'Simulation Stabilizing',
                desc: 'No critical events forecast. All colonies predicted to maintain current population levels for the next 60s.'
            });
        }

        this.predictions = finalPredictions.slice(0, 5);
    }
}

