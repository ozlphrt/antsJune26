/**
 * Colony and Ant Logic
 */

import { getTerrainHeight } from './terrain.js';

// Pre-allocated spatial grid cache to eliminate GC allocations and optimize collision performance
const gridCellSize = 3.5;
const gridDim = 40; // Covering [-70, 70]
const gridMin = -70;
const totalGridCells = gridDim * gridDim;
const collisionGrid = Array.from({ length: totalGridCells }, () => []);
const occupiedCells = [];
let _combatFrame = 0; // Module-level counter for staggered combat scan (alternates each update call)


class Ant {
    constructor(id, nestX, nestZ, colonyId) {
        this.id = id;
        this.x = nestX;
        this.z = nestZ;
        this.y = getTerrainHeight(nestX, nestZ);
        this.colonyId = colonyId;
        this.hp = 100;
        this.combatTarget = null;
        
        // Random starting angle
        this.angle = Math.random() * Math.PI * 2;
        
        // State: 'explore' (searching for food) or 'return' (carrying food)
        this.state = 'explore'; 
        
        // Pheromone strength left to deposit
        this.pheromoneStrength = 1.0;
        
        // Random wandering offset
        this.wanderAngle = 0;
        
        // Smoothed normal for slope orientation to prevent jitter
        this.normal = new THREE.Vector3(0, 1, 0);
        
        // To prevent getting stuck
        this.stuckTimer = 0;
        this.lastX = this.x;
        this.lastZ = this.z;
    }
    
    // Deposit pheromone on the grid
    depositPheromone(pheromones) {
        if (this.state === 'explore') {
            // Lay home pheromone so others can find home
            pheromones.deposit(this.x, this.z, 'home', this.pheromoneStrength * 0.8);
        } else {
            // Lay food pheromone to guide explore ants
            pheromones.deposit(this.x, this.z, 'food', this.pheromoneStrength * 1.5);
        }
        
        // Pheromone strength slowly degrades as they walk further from source
        this.pheromoneStrength = Math.max(0.05, this.pheromoneStrength * 0.995);
    }
    
    steer(pheromones, nestX, nestZ, foods, sensorAngleRad, sensorDist, speed, allColonies = null, ownColonyId = 0, freeFoodAvailable = false) {
        // 0. Combat steering priority
        if (this.combatTarget && this.combatTarget.hp > 0) {
            const dx = this.combatTarget.x - this.x;
            const dz = this.combatTarget.z - this.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < 36.0) { // 6.0 * 6.0
                const targetAngle = Math.atan2(this.combatTarget.x - this.x, this.combatTarget.z - this.z);
                this.angle = this.blendAngles(this.angle, targetAngle, 0.25);
                return;
            } else {
                this.combatTarget = null;
            }
        }

        // 1. Direct Target Attraction
        if (this.state === 'explore') {
            
            if (freeFoodAvailable) {
                // Look for nearby food piles to steer directly toward them (scaled for medium food size)
                let closestFood = null;
                let minDistSq = 256.0; // 16.0 * 16.0 Food detection radius
                
                for (let i = 0; i < foods.length; i++) {
                    const food = foods[i];
                    if (food.amount <= 0) continue;
                    
                    const dx = food.x - this.x;
                    const dz = food.z - this.z;
                    const d2 = dx*dx + dz*dz;
                    if (d2 < minDistSq) {
                        minDistSq = d2;
                        closestFood = food;
                    }
                }
                
                if (closestFood) {
                    const targetAngle = Math.atan2(closestFood.x - this.x, closestFood.z - this.z);
                    this.angle = this.blendAngles(this.angle, targetAngle, 0.25);
                    return;
                }
            } else if (allColonies) {
                // Free food depleted: steer toward the closest active opponent nest that has collected food
                let closestOpponentNest = null;
                let minDistSq = 9999999.0; // Large range to track nests across map
                
                for (let i = 0; i < allColonies.length; i++) {
                    const col = allColonies[i];
                    if (col.colonyId === ownColonyId || col.isGraveyard || col.foodCollected <= 0) continue;
                    
                    const dx = col.nestX - this.x;
                    const dz = col.nestZ - this.z;
                    const d2 = dx*dx + dz*dz;
                    if (d2 < minDistSq) {
                        minDistSq = d2;
                        closestOpponentNest = col;
                    }
                }
                
                if (closestOpponentNest) {
                    const targetAngle = Math.atan2(closestOpponentNest.nestX - this.x, closestOpponentNest.nestZ - this.z);
                    this.angle = this.blendAngles(this.angle, targetAngle, 0.25);
                    return;
                }
            }
        } else {
            // State: return. Steer directly to Nest if close enough
            const dx = nestX - this.x;
            const dz = nestZ - this.z;
            const distToNestSq = dx*dx + dz*dz;
            
            if (distToNestSq < 400.0) { // 20.0 * 20.0
                const targetAngle = Math.atan2(nestX - this.x, nestZ - this.z);
                this.angle = this.blendAngles(this.angle, targetAngle, 0.25);
                return;
            }
        }
        
        // 2. Sensor Pheromone Detection
        // Sense Left, Center, Right
        const centerAngle = this.angle;
        const leftAngle = this.angle - sensorAngleRad;
        const rightAngle = this.angle + sensorAngleRad;
        
        const typeToFollow = this.state === 'explore' ? 'food' : 'home';
        
        const sCenter = pheromones.getPheromone(this.x + Math.sin(centerAngle) * sensorDist, this.z + Math.cos(centerAngle) * sensorDist, typeToFollow);
        const sLeft   = pheromones.getPheromone(this.x + Math.sin(leftAngle) * sensorDist, this.z + Math.cos(leftAngle) * sensorDist, typeToFollow);
        const sRight  = pheromones.getPheromone(this.x + Math.sin(rightAngle) * sensorDist, this.z + Math.cos(rightAngle) * sensorDist, typeToFollow);
        
        // Steer selection
        if (sCenter > sLeft && sCenter > sRight) {
            // Keep going forward (slight random adjust)
            this.angle += (Math.random() - 0.5) * 0.05;
        } else if (sLeft > sRight && sLeft > 0.05) {
            // Turn Left
            this.angle = this.blendAngles(this.angle, leftAngle, 0.15);
        } else if (sRight > sLeft && sRight > 0.05) {
            // Turn Right
            this.angle = this.blendAngles(this.angle, rightAngle, 0.15);
        } else {
            // 3. Wander behavior (Brownian noise - blended to avoid twitching)
            this.wanderAngle += (Math.random() - 0.5) * 0.3;
            this.wanderAngle = Math.max(-0.6, Math.min(0.6, this.wanderAngle));
            this.angle = this.blendAngles(this.angle, this.angle + this.wanderAngle, 0.1);
        }
    }
    
    // Blend/lerp between angles smoothly
    blendAngles(current, target, rate) {
        let diff = target - current;
        // Keep diff between -PI and PI
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        
        // Clamp maximum turn speed per frame to keep animations silky smooth
        const maxTurnSpeed = 0.12; 
        const rawChange = diff * rate;
        const clampedChange = Math.max(-maxTurnSpeed, Math.min(maxTurnSpeed, rawChange));
        return current + clampedChange;
    }
    
    // Physical movement and boundary checks
    move(speed, worldLimit) {
        // Stop movement if engaged in close combat
        if (this.combatTarget && this.combatTarget.hp > 0) {
            const dx = this.combatTarget.x - this.x;
            const dz = this.combatTarget.z - this.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < 1.44) { // 1.2 * 1.2
                this.lastX = this.x;
                this.lastZ = this.z;
                return;
            }
        }

        // Update position
        this.x += Math.sin(this.angle) * speed;
        this.z += Math.cos(this.angle) * speed;
        
        // Map Y coordinate directly to terrain height
        this.y = getTerrainHeight(this.x, this.z);
        
        // Bounce off world boundaries (Redirect strongly toward the center of the map)
        const boundary = worldLimit / 2 - 2;
        let hitBoundary = false;
        if (Math.abs(this.x) > boundary) {
            this.x = Math.max(-boundary + 0.5, Math.min(boundary - 0.5, this.x));
            hitBoundary = true;
        }
        if (Math.abs(this.z) > boundary) {
            this.z = Math.max(-boundary + 0.5, Math.min(boundary - 0.5, this.z));
            hitBoundary = true;
        }
        
        if (hitBoundary) {
            const angleToCenter = Math.atan2(-this.x, -this.z);
            this.angle = angleToCenter + (Math.random() - 0.5) * 0.5;
        }
        
        // Stuck detection
        const dx = this.x - this.lastX;
        const dz = this.z - this.lastZ;
        const distMoved = Math.sqrt(dx*dx + dz*dz);
        
        if (distMoved < speed * 0.1) {
            this.stuckTimer++;
            if (this.stuckTimer > 20) {
                // Steer randomly to break free
                this.angle = Math.random() * Math.PI * 2;
                this.stuckTimer = 0;
            }
        } else {
            this.stuckTimer = 0;
        }
        
        this.lastX = this.x;
        this.lastZ = this.z;
    }
}

// Helper to merge simple buffer geometries manually without external libraries
function mergeGeometries(geometries) {
    let totalVertices = 0;
    let totalIndices = 0;
    
    for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        totalVertices += g.attributes.position.count;
        if (g.index) totalIndices += g.index.count;
    }
    
    const merged = new THREE.BufferGeometry();
    
    // Merge positions
    const positions = new Float32Array(totalVertices * 3);
    let vOffset = 0;
    for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        positions.set(g.attributes.position.array, vOffset * 3);
        vOffset += g.attributes.position.count;
    }
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    // Merge indices
    if (totalIndices > 0) {
        const indices = new Uint16Array(totalIndices);
        let iOffset = 0;
        let vertexOffset = 0;
        for (let i = 0; i < geometries.length; i++) {
            const g = geometries[i];
            if (g.index) {
                const array = g.index.array;
                for (let j = 0; j < array.length; j++) {
                    indices[iOffset + j] = array[j] + vertexOffset;
                }
                iOffset += array.length;
            }
            vertexOffset += g.attributes.position.count;
        }
        merged.setIndex(new THREE.BufferAttribute(indices, 1));
    }
    
    return merged;
}

export class ColonyManager {
    constructor(scene, nestX, nestZ, initialAntCount, colonyId = 0, exploreColor = 0xef4444, carryingColor = 0x10b981, sharedFoods = null, sharedObstacles = null) {
        this.scene = scene;
        this.nestX = nestX;
        this.nestZ = nestZ;
        this.colonyId = colonyId;
        this.exploreColor = new THREE.Color(exploreColor);
        this.carryingColor = new THREE.Color(carryingColor);
        
        this.ants = [];
        this.foods = sharedFoods || [];
        this.obstacles = sharedObstacles || [];
        this.foodCollected = 0;
        this.foodStolen = 0;
        this.personality = 'dove'; // Game theory personality: 'hawk', 'dove', 'grudger', 'bully'
        this.stances = {}; // colonyId -> 'Allied' | 'Neutral' | 'Hostile'
        this.foodPileData = [];
        this.antsDefeated = 0;
        
        // Simulation parameters (controlled via UI)
        this.antSpeed = 1.0;
        this.sensorAngle = 35 * Math.PI / 180;
        this.sensorDistance = 3.0;
        
        // Visual variables
        this.instancedMesh = null;
        this.foodPileGroup = null;
        this.createAntVisuals(initialAntCount);

        // Pre-allocated scratch objects — reused every frame to avoid GC pressure
        this._scratchForward = new THREE.Vector3();
        this._scratchRight   = new THREE.Vector3();
        this._scratchAdjFwd  = new THREE.Vector3();
        this._scratchNormal  = new THREE.Vector3();
        this._scratchRotMat  = new THREE.Matrix4();
        this._hiddenDummy    = new THREE.Object3D();
        this._hiddenDummy.position.set(9999, 9999, 9999);
        this._hiddenDummy.updateMatrix();

        // Setup initial population
        this.setPopulation(initialAntCount);
    }
    
    addObstacle(x, z, radius, mesh) {
        this.obstacles.push({
            x: x,
            z: z,
            radius: radius,
            mesh: mesh
        });
    }
    
    // Create instanced meshes for fast rendering
    createAntVisuals(count) {
        // Use a fixed pool size to prevent recreating the Three.js InstancedMesh which causes flickering
        const poolSize = Math.max(count, 2000);
        
        if (this.instancedMesh) {
            if (this.instancedMesh.count === poolSize) {
                // Already have the correct size pool, no need to recreate
                return;
            }
            this.scene.remove(this.instancedMesh);
        }
        if (this.foodCarriedMesh) {
            this.scene.remove(this.foodCarriedMesh);
        }
        
        // Build a detailed 3-segment minimalist ant body shape (low-poly spheres)
        const headGeom = new THREE.SphereGeometry(0.18, 5, 5);
        headGeom.translate(0, 0.05, 0.45); // Forward
        
        const thoraxGeom = new THREE.SphereGeometry(0.14, 5, 5);
        thoraxGeom.translate(0, 0, 0.05); // Central
        
        const abdomenGeom = new THREE.SphereGeometry(0.24, 5, 5);
        abdomenGeom.scale(0.8, 0.8, 1.4); // Elongated
        abdomenGeom.translate(0, 0.05, -0.45); // Backward
        
        // Merge segments into a single composite ant geometry
        const geometry = mergeGeometries([headGeom, thoraxGeom, abdomenGeom]);
        geometry.computeVertexNormals();
        
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.95, // Matte finish, completely non-shiny
            metalness: 0.05,
            flatShading: true
        });
        
        this.instancedMesh = new THREE.InstancedMesh(geometry, material, poolSize);
        this.instancedMesh.castShadow = true;
        this.instancedMesh.receiveShadow = false;
        this.scene.add(this.instancedMesh);
        
        // Hide all instances initially
        const hiddenDummy = new THREE.Object3D();
        hiddenDummy.position.set(9999, 9999, 9999);
        hiddenDummy.updateMatrix();
        for (let i = 0; i < poolSize; i++) {
            this.instancedMesh.setMatrixAt(i, hiddenDummy.matrix);
        }
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        
        // Immediately color and position existing ants on the new mesh to prevent rendering as default white
        if (this.ants && this.ants.length > 0) {
            const dummy = new THREE.Object3D();
            const colorForaging = this.exploreColor;
            for (let i = 0; i < Math.min(this.ants.length, poolSize); i++) {
                const ant = this.ants[i];
                dummy.position.set(ant.x, ant.y + 0.3, ant.z);
                
                const dirX = Math.sin(ant.angle);
                const dirZ = Math.cos(ant.angle);
                const forward = new THREE.Vector3(dirX, 0, dirZ).normalize();
                const normal = ant.normal || new THREE.Vector3(0, 1, 0);
                const right = new THREE.Vector3().crossVectors(forward, normal).normalize();
                const adjustedForward = new THREE.Vector3().crossVectors(normal, right).normalize();
                const rotMatrix = new THREE.Matrix4().makeBasis(right, normal, adjustedForward);
                dummy.rotation.setFromRotationMatrix(rotMatrix);
                dummy.updateMatrix();
                
                this.instancedMesh.setMatrixAt(i, dummy.matrix);
                this.instancedMesh.setColorAt(i, colorForaging);
            }
            this.instancedMesh.instanceMatrix.needsUpdate = true;
            if (this.instancedMesh.instanceColor) {
                this.instancedMesh.instanceColor.needsUpdate = true;
            }
        }

        // Build the small red food carrying mesh (larger and brighter for maximum visibility)
        const foodCarrierGeom = new THREE.SphereGeometry(0.26, 6, 6);
        foodCarrierGeom.translate(0, 0.12, 0.82); // Positioned clearly in front of mouth/head and raised to avoid clipping
        const foodCarrierMat = new THREE.MeshStandardMaterial({
            color: 0xff0000, // Pure super-saturated red
            emissive: 0xff0000, // Ultra-bright glowing red
            emissiveIntensity: 4.5, // Boosted emissive shine for extreme saturation
            roughness: 0.05, // Highly polished/glossy
            metalness: 0.1,
            flatShading: true
        });
        this.foodCarriedMesh = new THREE.InstancedMesh(foodCarrierGeom, foodCarrierMat, poolSize);
        this.foodCarriedMesh.castShadow = true;
        // Position all food meshes at hidden location initially
        for (let i = 0; i < poolSize; i++) {
            this.foodCarriedMesh.setMatrixAt(i, hiddenDummy.matrix);
        }
        this.foodCarriedMesh.instanceMatrix.needsUpdate = true;
        this.scene.add(this.foodCarriedMesh);
    }

    updateNestFoodPile(antX, antZ) {
        if (!this.foodPileGroup) {
            this.foodPileGroup = new THREE.Group();
            const yPos = getTerrainHeight(this.nestX, this.nestZ);
            this.foodPileGroup.position.set(this.nestX, yPos, this.nestZ);
            this.scene.add(this.foodPileGroup);
        }
        
        const contactRadius = 0.45;
        const maxLayers = 3; // Capped stack height (0, 1, 2, 3) to prevent tall floating columns
        
        const getLayerAt = (x, z) => {
            let highestLayer = -1;
            for (const p of this.foodPileData) {
                const pdx = p.x - x;
                const pdz = p.z - z;
                if (Math.sqrt(pdx * pdx + pdz * pdz) < contactRadius) {
                    if (p.layer > highestLayer) {
                        highestLayer = p.layer;
                    }
                }
            }
            return highestLayer + 1;
        };
        
        const searchSteps = [
            // Ring 1 (close offsets)
            { dx: 0.35, dz: 0 }, { dx: -0.35, dz: 0 }, { dx: 0, dz: 0.35 }, { dx: 0, dz: -0.35 },
            { dx: 0.25, dz: 0.25 }, { dx: -0.25, dz: 0.25 }, { dx: 0.25, dz: -0.25 }, { dx: -0.25, dz: -0.25 },
            // Ring 2 (wider offsets)
            { dx: 0.7, dz: 0 }, { dx: -0.7, dz: 0 }, { dx: 0, dz: 0.7 }, { dx: 0, dz: -0.7 },
            { dx: 0.5, dz: 0.5 }, { dx: -0.5, dz: 0.5 }, { dx: 0.5, dz: -0.5 }, { dx: -0.5, dz: -0.5 }
        ];
        
        // If ant coordinates are provided, compute position relative to nest center based on approach angle
        if (antX !== undefined && antZ !== undefined) {
            if (window.nests && window.nests[this.colonyId]) {
                window.nests[this.colonyId].userData.depositPulse = 1.0;
            }
            const dx = antX - this.nestX;
            const dz = antZ - this.nestZ;
            const dist = Math.sqrt(dx * dx + dz * dz);
            
            // Place food at the outer boundary of the nest mound
            const placementRadius = 2.4;
            let rx = dist > 0 ? (dx / dist) * placementRadius : placementRadius;
            let rz = dist > 0 ? (dz / dist) * placementRadius : 0;
            
            let layer = getLayerAt(rx, rz);
            
            // Roll-off: Spill over horizontally to nearby spots if stack is too high
            if (layer > maxLayers) {
                let bestRx = rx;
                let bestRz = rz;
                let lowestLayer = layer;
                
                for (const step of searchSteps) {
                    const testRx = rx + step.dx;
                    const testRz = rz + step.dz;
                    const testLayer = getLayerAt(testRx, testRz);
                    if (testLayer < lowestLayer) {
                        lowestLayer = testLayer;
                        bestRx = testRx;
                        bestRz = testRz;
                        if (lowestLayer <= maxLayers) {
                            break;
                        }
                    }
                }
                rx = bestRx;
                rz = bestRz;
                layer = lowestLayer;
            }
            
            this.foodPileData.push({
                x: rx,
                z: rz,
                angle: Math.atan2(rz, rx),
                layer: layer
            });
        }

        // Cap visible pile at 120 chunks — beyond this it becomes indistinct and each chunk is a draw call
        const MAX_PILE_CHUNKS = 120;
        const targetChunks = Math.min(this.foodCollected, MAX_PILE_CHUNKS);
        
        while (this.foodPileData.length < targetChunks) {
            // Generate fallback piece at random angle if there's any data mismatch
            const angle = Math.random() * Math.PI * 2;
            let rx = Math.cos(angle) * 2.4;
            let rz = Math.sin(angle) * 2.4;
            
            let layer = getLayerAt(rx, rz);
            
            if (layer > maxLayers) {
                let bestRx = rx;
                let bestRz = rz;
                let lowestLayer = layer;
                
                for (const step of searchSteps) {
                    const testRx = rx + step.dx;
                    const testRz = rz + step.dz;
                    const testLayer = getLayerAt(testRx, testRz);
                    if (testLayer < lowestLayer) {
                        lowestLayer = testLayer;
                        bestRx = testRx;
                        bestRz = testRz;
                        if (lowestLayer <= maxLayers) {
                            break;
                        }
                    }
                }
                rx = bestRx;
                rz = bestRz;
                layer = lowestLayer;
            }
            
            this.foodPileData.push({
                x: rx,
                z: rz,
                angle: angle,
                layer: layer
            });
        }
        
        if (this.foodPileData.length > targetChunks) {
            this.foodPileData.length = targetChunks;
        }
        
        const currentChunks = this.foodPileGroup.children.length;
        
        if (targetChunks > currentChunks) {
            const tsMat = new THREE.MeshStandardMaterial({
                color: 0xef4444, // Apple red skin
                roughness: 0.75,
                metalness: 0.1,
                flatShading: true
            });
            
            const chunkGeom = new THREE.OctahedronGeometry(0.3, 0);
            chunkGeom.scale(1.0, 0.45, 0.7); // Flattened wedge shape
            
            const yPos = getTerrainHeight(this.nestX, this.nestZ);
            
            for (let i = currentChunks; i < targetChunks; i++) {
                const data = this.foodPileData[i];
                const chunk = new THREE.Mesh(chunkGeom, tsMat);
                chunk.castShadow = true;
                chunk.receiveShadow = true;
                
                // Calculate precise local Y offset so it rests on the terrain surface
                const worldX = this.nestX + data.x;
                const worldZ = this.nestZ + data.z;
                const terrainY = getTerrainHeight(worldX, worldZ);
                const groundY = terrainY - yPos; // terrain relative to nest center
                
                // Stack layers vertically
                const yOffset = 0.05 + data.layer * 0.14; // Stack closely on top of lower pieces
                
                chunk.position.set(data.x, groundY + yOffset, data.z);
                
                // Rotate organic look based on approach angle and stack depth
                chunk.rotation.set(
                    (Math.sin(i * 3.1) * 0.15) - 0.075,
                    data.angle + data.layer * 0.25,
                    (Math.cos(i * 2.5) * 0.15) - 0.075
                );
                
                this.foodPileGroup.add(chunk);
            }
        } else if (targetChunks < currentChunks) {
            // Remove chunks if count goes down (e.g., reset)
            while (this.foodPileGroup.children.length > targetChunks) {
                const child = this.foodPileGroup.children[this.foodPileGroup.children.length - 1];
                this.foodPileGroup.remove(child);
                child.geometry.dispose();
                child.material.dispose();
            }
        }
    }
    
    setPopulation(targetCount) {
        const currentCount = this.ants.length;
        if (targetCount === currentCount) return;
        
        if (targetCount > currentCount) {
            // Spawn new ants
            for (let i = currentCount; i < targetCount; i++) {
                this.ants.push(new Ant(i, this.nestX, this.nestZ, this.colonyId));
            }
        } else {
            // Kill excess ants
            this.ants.length = targetCount;
        }
        
        // Re-create instanced mesh with new capacity
        this.createAntVisuals(targetCount);
    }
    
    addFoodSource(x, z, amount, isLoot = false) {
        const group = new THREE.Group();
        let yOffset = 0.5;
        let radius = 1.5;
        
        if (isLoot) {
            // Sliced piece of apple (a small low-poly wedge shape using Octahedron scaled irregularly)
            const bodyGeom = new THREE.OctahedronGeometry(0.65, 0);
            bodyGeom.scale(0.8, 0.4, 0.6); // Flat sliced look with sharp corners
            bodyGeom.computeVertexNormals();
            bodyGeom.computeBoundingBox();
            yOffset = -bodyGeom.boundingBox.min.y;
            radius = 0.65;
            
            const bodyMat = new THREE.MeshStandardMaterial({
                color: 0xef4444, // Red apple skin
                roughness: 0.8,
                metalness: 0.1,
                flatShading: true
            });
            const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
            bodyMesh.castShadow = true;
            bodyMesh.receiveShadow = true;
            group.add(bodyMesh);
        } else {
            // 1. Apple Body (Custom deformed sphere)
            const bodyGeom = new THREE.SphereGeometry(1.5, 16, 16);
            const position = bodyGeom.attributes.position;
            for (let i = 0; i < position.count; i++) {
                let px = position.getX(i);
                let py = position.getY(i);
                let pz = position.getZ(i);
                
                // Normalize y to [-1, 1]
                const ny = py / 1.5;
                
                // Apple shape factor: dimple at the top (ny > 0) and bottom (ny < 0)
                const topDimple = Math.pow(Math.max(0, ny), 3) * 0.25;
                const bottomDimple = Math.pow(Math.max(0, -ny), 3) * 0.15;
                py -= (topDimple - bottomDimple) * 1.5;
                
                // Profile: wider at shoulders, narrower at base
                const profile = 1.0 + 0.12 * ny - 0.08 * ny * ny;
                px *= profile;
                pz *= profile;
                
                position.setXYZ(i, px, py, pz);
            }
            
            bodyGeom.scale(1.0, 0.85, 1.0); // Squash Y slightly
            bodyGeom.computeVertexNormals();
            bodyGeom.computeBoundingBox();
            yOffset = -bodyGeom.boundingBox.min.y;
            const maxY = bodyGeom.boundingBox.max.y;
            
            const bodyMat = new THREE.MeshStandardMaterial({
                color: 0xef4444, // Apple Red
                roughness: 0.5,
                metalness: 0.1,
                flatShading: true
            });
            const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
            bodyMesh.castShadow = true;
            bodyMesh.receiveShadow = true;
            group.add(bodyMesh);
            
            // 2. Apple Stem (Small cylinder)
            const stemGeom = new THREE.CylinderGeometry(0.04, 0.06, 0.6, 8);
            stemGeom.translate(0, maxY + 0.25, 0); // Position so it starts slightly inside the top dimple
            stemGeom.rotateZ(0.15); // Tilt stem slightly
            const stemMat = new THREE.MeshStandardMaterial({
                color: 0x5c3f25, // Rich brown
                roughness: 0.9,
                flatShading: true
            });
            const stemMesh = new THREE.Mesh(stemGeom, stemMat);
            stemMesh.castShadow = true;
            group.add(stemMesh);
            
            // 3. Apple Leaf (Flat leaf shape)
            const leafGeom = new THREE.DodecahedronGeometry(0.25, 0);
            leafGeom.scale(2.0, 0.4, 1.0); // Flat leaf shape
            leafGeom.translate(0.3, maxY + 0.45, 0.1); // Position on the stem
            leafGeom.rotateY(0.4);
            leafGeom.rotateZ(-0.2);
            const leafMat = new THREE.MeshStandardMaterial({
                color: 0x15803d, // Rich green leaf
                roughness: 0.8,
                flatShading: true
            });
            const leafMesh = new THREE.Mesh(leafGeom, leafMat);
            leafMesh.castShadow = true;
            group.add(leafMesh);
        }
        
        const terrainH = getTerrainHeight(x, z);
        group.position.set(x, terrainH + yOffset, z); // Initial height sitting on terrain
        this.scene.add(group);
        
        this.foods.push({
            x: x,
            z: z,
            lastX: x,
            lastZ: z,
            vx: 0,
            vz: 0,
            amount: amount,
            maxAmount: isLoot ? 15 : amount, // If loot, visually scale down to ~0.35x tiny slice
            mesh: group,
            radius: radius,
            yOffset: yOffset,
            isLoot: isLoot
        });
    }
    
    update(pheromones, worldSize, allColonies = null) {
        const dummy = new THREE.Object3D();
        const colorForaging = this.exploreColor;
        const colorCarrying = this.carryingColor;
        const dt = 0.016;
        // Compute once per frame — avoid per-ant foods.some() scan
        const freeFoodAvailable = this.foods.some(f => f.amount > 0);
        
        // Pre-compute live population counts once per frame (avoids per-ant .filter() GC allocations)
        // Used by bully/dove logic below
        const liveCount = new Int32Array(allColonies ? allColonies.length : 0);
        if (allColonies) {
            for (let c = 0; c < allColonies.length; c++) {
                const col = allColonies[c];
                for (let a = 0; a < col.ants.length; a++) {
                    if (col.ants[a].hp > 0) liveCount[c]++;
                }
            }
        }
        const ownLiveCount = allColonies ? liveCount[this.colonyId] : 0;
        
        // Global frame parity for staggered combat scan (shared across all colony updates per frame)
        _combatFrame = (_combatFrame + 1) & 0xFFFF;
        const combatFrameParity = _combatFrame & 1;

        // Combat updates: check proximity, target acquisition, deal damage, handle respawns
        if (allColonies) {
            for (let i = 0; i < this.ants.length; i++) {
                const ant = this.ants[i];
                if (ant.hp <= 0) continue;
                
                // Target selection — stagger: only scan for new targets on ants whose index
                // parity matches the current frame parity. Ants with existing valid targets
                // always proceed to the damage block below regardless.
                if (!ant.combatTarget || ant.combatTarget.hp <= 0) {
                    if ((i & 1) !== combatFrameParity) continue; // Skip scan this frame
                    // Check if ant is in an engagement zone (near food or near nests)
                    let nearFood = false;
                    for (let f = 0; f < this.foods.length; f++) {
                        const food = this.foods[f];
                        if (food.amount <= 0) continue;
                        const fdx = food.x - ant.x;
                        const fdz = food.z - ant.z;
                        if (fdx*fdx + fdz*fdz < 16.0 * 16.0) {
                            nearFood = true;
                            break;
                        }
                    }
                    
                    let nearNest = false;
                    for (let c = 0; c < allColonies.length; c++) {
                        const col = allColonies[c];
                        const ndx = col.nestX - ant.x;
                        const ndz = col.nestZ - ant.z;
                        if (ndx*ndx + ndz*ndz < 20.0 * 20.0) {
                            nearNest = true;
                            break;
                        }
                    }
                    
                    if (nearFood || nearNest) {
                        // Scan for closest enemy within 5.0 units
                        let closestEnemy = null;
                        let closestEnemyDist = 5.0;
                        let enemyColony = null;
                        
                        for (let c = 0; c < allColonies.length; c++) {
                            const col = allColonies[c];
                            if (col.colonyId === this.colonyId) continue;
                            
                            // Check diplomatic stance
                            const stance = this.stances[col.colonyId] || 'Neutral';
                            if (stance === 'Allied') continue; // Allied colonies never fight

                            for (let a = 0; a < col.ants.length; a++) {
                                const enemy = col.ants[a];
                                if (enemy.hp <= 0) continue;
                                
                                const edx = enemy.x - ant.x;
                                const edz = enemy.z - ant.z;
                                const d = Math.sqrt(edx*edx + edz*edz);
                                if (d < closestEnemyDist) {
                                    closestEnemyDist = d;
                                    closestEnemy = enemy;
                                    enemyColony = col;
                                }
                            }
                        }
                        
                        if (closestEnemy && enemyColony) {
                            const stance = this.stances[enemyColony.colonyId] || 'Neutral';
                            
                            if (stance === 'Hostile') {
                                // Fight on sight
                                ant.combatTarget = closestEnemy;
                                if (!closestEnemy.combatTarget) {
                                    closestEnemy.combatTarget = ant;
                                }
                            } else if (stance === 'Neutral') {
                                // Decide based on game theory / personality
                                const p = this.personality;
                                
                                if (p === 'hawk') {
                                    // Hawks always attack (defect)
                                    ant.combatTarget = closestEnemy;
                                    if (!closestEnemy.combatTarget) {
                                        closestEnemy.combatTarget = ant;
                                    }
                                } else if (p === 'bully') {
                                    // Bully attacks only if we have a population advantage > 20%
                                    // Uses pre-computed liveCount to avoid per-ant .filter() GC cost
                                    const theirLive = liveCount[enemyColony.colonyId];
                                    if (ownLiveCount > theirLive * 1.2) {
                                        ant.combatTarget = closestEnemy;
                                        if (!closestEnemy.combatTarget) {
                                            closestEnemy.combatTarget = ant;
                                        }
                                    } else {
                                        // Flee if they are aggressive or targeting us
                                        if (closestEnemy.combatTarget === ant || enemyColony.personality === 'hawk') {
                                            ant.angle = Math.atan2(ant.x - closestEnemy.x, ant.z - closestEnemy.z) + (Math.random() - 0.5) * 0.3;
                                        }
                                    }
                                } else {
                                    // Dove or Grudger (starts as Dove)
                                    if (closestEnemy.combatTarget === ant) {
                                        // Defend if targeted
                                        ant.combatTarget = closestEnemy;
                                    } else if (enemyColony.personality === 'hawk' || (enemyColony.personality === 'bully' && liveCount[enemyColony.colonyId] > ownLiveCount * 1.2)) {
                                        // Flee if the other is a hawk/bully
                                        ant.angle = Math.atan2(ant.x - closestEnemy.x, ant.z - closestEnemy.z) + (Math.random() - 0.5) * 0.3;
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Damage Dealing
                if (ant.combatTarget && ant.combatTarget.hp > 0) {
                    const dx = ant.combatTarget.x - ant.x;
                    const dz = ant.combatTarget.z - ant.z;
                    const dist = Math.sqrt(dx*dx + dz*dz);
                    
                    if (dist < 1.2) {
                        // Apply attack damage
                        const dxHome = this.nestX - ant.x;
                        const dzHome = this.nestZ - ant.z;
                        const distToHome = Math.sqrt(dxHome*dxHome + dzHome*dzHome);
                        const isHomeTurf = distToHome < 20.0;
                        
                        let dmg = (15 + Math.random() * 20) * dt;
                        if (isHomeTurf) dmg *= 1.5; // Home defense buff
                        
                        ant.combatTarget.hp -= dmg;
                        
                        // Spawn combat sparks occasionally
                        if (Math.random() < 0.12 && window.spawnCombatSparks) {
                            if (window.playHitSound) {
                                window.playHitSound();
                            }
                            // Find opponent colony color
                            let opponentExploreColor = 0xffffff;
                            const opponentColony = allColonies.find(c => c.colonyId === ant.combatTarget.colonyId);
                            if (opponentColony) {
                                opponentExploreColor = opponentColony.exploreColor;
                            }
                            window.spawnCombatSparks(
                                (ant.x + ant.combatTarget.x) * 0.5,
                                (ant.y + ant.combatTarget.y) * 0.5,
                                (ant.z + ant.combatTarget.z) * 0.5,
                                ant.state === 'explore' ? this.exploreColor : this.carryingColor,
                                opponentExploreColor
                            );
                        }
                        
                        // Handle opponent death
                        if (ant.combatTarget.hp <= 0) {
                            // Increment defeated (death) count for opponent colony and record stats
                            const targetColony = allColonies.find(c => c.colonyId === ant.combatTarget.colonyId);
                            if (targetColony) {
                                targetColony.antsDefeated++;
                                if (window.statsEngine) {
                                    window.statsEngine.recordKill(this.colonyId, targetColony.colonyId);
                                }
                            }
                            
                            // Trigger bionic blood splash particles and floating health bag
                            if (window.spawnBloodSplash) {
                                window.spawnBloodSplash(ant.combatTarget.x, ant.combatTarget.y, ant.combatTarget.z);
                            }
                            if (window.spawnHealthBag) {
                                window.spawnHealthBag(ant.combatTarget.x, ant.combatTarget.y, ant.combatTarget.z);
                            }
                            
                            if (ant.combatTarget.state === 'return') {
                                // Drop food at coordinates as a tiny bite-sized loot piece
                                if (targetColony) {
                                    targetColony.addFoodSource(ant.combatTarget.x, ant.combatTarget.z, 1, true);
                                } else {
                                    this.addFoodSource(ant.combatTarget.x, ant.combatTarget.z, 1, true);
                                }
                            }
                            
                            // Apply combat mode scenario
                            const mode = window.combatMode || 'respawn';
                            if (mode === 'removal' && targetColony) {
                                const defeatedAnt = ant.combatTarget;
                                const idx = targetColony.ants.indexOf(defeatedAnt);
                                if (idx !== -1) {
                                    targetColony.ants.splice(idx, 1);
                                    targetColony.createAntVisuals(targetColony.ants.length);
                                }
                            } else if (mode === 'conversion' && targetColony) {
                                const defeatedAnt = ant.combatTarget;
                                const idx = targetColony.ants.indexOf(defeatedAnt);
                                if (idx !== -1) {
                                    targetColony.ants.splice(idx, 1);
                                    targetColony.createAntVisuals(targetColony.ants.length);
                                }
                                
                                // Convert attributes to the winning colony
                                defeatedAnt.colonyId = this.colonyId;
                                defeatedAnt.hp = 100;
                                defeatedAnt.state = 'explore';
                                defeatedAnt.pheromoneStrength = 1.0;
                                defeatedAnt.combatTarget = null;
                                defeatedAnt.angle = Math.random() * Math.PI * 2;
                                defeatedAnt.id = this.ants.length;
                                
                                this.ants.push(defeatedAnt);
                                this.createAntVisuals(this.ants.length);
                            }
                            
                            ant.combatTarget = null;
                        }
                    }
                }
            }
        }
        
        // Food Physics Loop: Roll down slopes and bounce off obstacles (ONLY run on primary colonyId === 0 to avoid redundant physics ticks)
        if (this.colonyId === 0) {
            const dt = 0.016; // Fixed timestep simulation delta
            const boundary = worldSize / 2 - 4;
            
            // A. Food-to-Food physical collisions (solid contact)
            for (let i = 0; i < this.foods.length; i++) {
                const a = this.foods[i];
                const rA = 1.6;
                for (let j = i + 1; j < this.foods.length; j++) {
                    const b = this.foods[j];
                    const rB = 1.6;
                    
                    const dx = b.x - a.x;
                    const dz = b.z - a.z;
                    const distSq = dx * dx + dz * dz;
                    const minDist = rA + rB;
                    const minDistSq = minDist * minDist;
                    
                    if (distSq < minDistSq) {
                        const dist = Math.sqrt(distSq);
                        if (dist > 0.001) {
                            const nx = dx / dist;
                            const nz = dz / dist;
                            const overlap = (minDist - dist) * 0.5;
                            
                            // Push apart
                            a.x -= nx * overlap;
                            a.z -= nz * overlap;
                            b.x += nx * overlap;
                            b.z += nz * overlap;
                            
                            // Simple inelastic velocity exchange (heavy apples absorb energy)
                            const kx = a.vx - b.vx;
                            const kz = a.vz - b.vz;
                            const p = (nx * kx + nz * kz) * 0.15; // Muted momentum transfer
                            
                            a.vx -= p * nx;
                            a.vz -= p * nz;
                            b.vx += p * nx;
                            b.vz += p * nz;
                        }
                    }
                }
            }
            
            // B. Gravity and Obstacle Bounces
            for (let i = 0; i < this.foods.length; i++) {
                const food = this.foods[i];
                const foodRadius = 1.6;
                
                // 1. Calculate height differences to estimate local terrain slope gradient
                const delta = 3.0;
                const hL = getTerrainHeight(food.x - delta, food.z);
                const hR = getTerrainHeight(food.x + delta, food.z);
                const hD = getTerrainHeight(food.x, food.z - delta);
                const hU = getTerrainHeight(food.x, food.z + delta);
                
                // Moderate slope gravity pull
                const fx = (hL - hR) * 0.18;
                const fz = (hD - hU) * 0.18;
                
                if (food.isLoot) {
                    // Sliced apple chunks are static and cannot roll down hills
                    food.vx = 0;
                    food.vz = 0;
                } else {
                    food.vx += fx;
                    food.vz += fz;
                    
                    // Heavy rolling friction (damping factor set to 0.86 to simulate weight/resistance)
                    food.vx *= 0.86;
                    food.vz *= 0.86;
                }
                
                // Static Friction / Rolling Resistance Threshold:
                // If the slope force is low and velocity is tiny, lock the apple in place so it doesn't drift.
                const speed = Math.sqrt(food.vx * food.vx + food.vz * food.vz);
                const forceMag = Math.sqrt(fx * fx + fz * fz);
                if (speed < 0.035 && forceMag < 0.05) {
                    food.vx = 0;
                    food.vz = 0;
                }
                
                // Update coordinates
                food.x += food.vx;
                food.z += food.vz;
                
                // 2. Obstacle Collisions (Bounce and Push out)
                for (let j = 0; j < this.obstacles.length; j++) {
                    const obs = this.obstacles[j];
                    const dx = food.x - obs.x;
                    const dz = food.z - obs.z;
                    const distSq = dx * dx + dz * dz;
                    const minDist = obs.radius + foodRadius - 0.2;
                    const minDistSq = minDist * minDist;
                    
                    if (distSq < minDistSq) {
                        const dist = Math.sqrt(distSq);
                        if (dist > 0.001) {
                            const nx = dx / dist;
                            const nz = dz / dist;
                            
                            // Push outside of the obstacle
                            food.x = obs.x + nx * minDist;
                            food.z = obs.z + nz * minDist;
                            
                            // Inelastic thud reflection (bounce factor 0.1 for high weight)
                            const dot = food.vx * nx + food.vz * nz;
                            if (dot < 0) {
                                food.vx = (food.vx - 2 * dot * nx) * 0.1;
                                food.vz = (food.vz - 2 * dot * nz) * 0.1;
                            }
                        }
                    }
                }
                
                // 3. Bound within world limits
                if (Math.abs(food.x) > boundary) {
                    food.x = Math.sign(food.x) * boundary;
                    food.vx = -food.vx * 0.4;
                }
                if (Math.abs(food.z) > boundary) {
                    food.z = Math.sign(food.z) * boundary;
                    food.vz = -food.vz * 0.4;
                }
                
                // 4. Update visual 3D position & apply rolling rotation based on ACTUAL displacement
                const terrainH = getTerrainHeight(food.x, food.z);
                const scale = 0.3 + 0.7 * (food.amount / food.maxAmount);
                food.mesh.scale.set(scale, scale, scale);
                food.mesh.position.set(food.x, terrainH + (food.yOffset || 1.275) * scale, food.z); // Sit flat on terrain base
                
                const dx = food.x - food.lastX;
                const dz = food.z - food.lastZ;
                const distMoved = Math.sqrt(dx * dx + dz * dz);
                
                if (distMoved > 0.001 && !food.isLoot) {
                    // Rotation axis is perpendicular to actual displacement vector in X-Z plane (corrected for forward roll)
                    const axis = new THREE.Vector3(dz, 0, -dx).normalize();
                    const rollAngle = distMoved / foodRadius;
                    food.mesh.rotateOnWorldAxis(axis, rollAngle);
                }
                
                // Store current position for next frame displacement checks
                food.lastX = food.x;
                food.lastZ = food.z;
            }
        }
        
        // Ant-to-ant physical collision avoidance (Global across all colonies to make them act as solid objects)
        if (allColonies) {
            if (this.colonyId === 0) {
                // Clear pre-allocated spatial grid
                for (let idx = 0; idx < totalGridCells; idx++) {
                    collisionGrid[idx].length = 0;
                }
                occupiedCells.length = 0;

                // Gather and bin ALL active ants from all colonies
                for (let c = 0; c < allColonies.length; c++) {
                    const col = allColonies[c];
                    for (let a = 0; a < col.ants.length; a++) {
                        const ant = col.ants[a];
                        if (ant.hp > 0) {
                            const cx = Math.floor((ant.x - gridMin) / gridCellSize);
                            const cz = Math.floor((ant.z - gridMin) / gridCellSize);
                            if (cx >= 0 && cx < gridDim && cz >= 0 && cz < gridDim) {
                                const idx = cz * gridDim + cx;
                                if (collisionGrid[idx].length === 0) {
                                    occupiedCells.push(idx);
                                }
                                collisionGrid[idx].push(ant);
                            }
                        }
                    }
                }

                const minDist = 0.55; // Body diameter boundary (solid contact size)
                const minDistSq = minDist * minDist;

                for (let o = 0; o < occupiedCells.length; o++) {
                    const cellIdx = occupiedCells[o];
                    const cellAnts = collisionGrid[cellIdx];
                    const cx = cellIdx % gridDim;
                    const cz = Math.floor(cellIdx / gridDim);

                    // Compare ants within the same cell
                    for (let i = 0; i < cellAnts.length; i++) {
                        const a = cellAnts[i];
                        for (let j = i + 1; j < cellAnts.length; j++) {
                            const b = cellAnts[j];
                            const dx = b.x - a.x;
                            const dz = b.z - a.z;
                            const distSq = dx * dx + dz * dz;

                            if (distSq < minDistSq) {
                                const dist = Math.sqrt(distSq);
                                const overlap = (minDist - dist) * 0.5;
                                const pushX = (dist > 0.001) ? (dx / dist) * overlap : (Math.random() - 0.5) * minDist * 0.5;
                                const pushZ = (dist > 0.001) ? (dz / dist) * overlap : (Math.random() - 0.5) * minDist * 0.5;

                                a.x -= pushX;
                                a.z -= pushZ;
                                b.x += pushX;
                                b.z += pushZ;

                                a.y = getTerrainHeight(a.x, a.z);
                                b.y = getTerrainHeight(b.x, b.z);

                                // Steer away from each other slightly to avoid lockups
                                const escapeAngleA = Math.atan2(dx, dz) + Math.PI;
                                const escapeAngleB = Math.atan2(dx, dz);
                                a.angle = a.blendAngles(a.angle, escapeAngleA, 0.05);
                                b.angle = b.blendAngles(b.angle, escapeAngleB, 0.05);
                            }
                        }
                    }

                    // Compare with neighbor cells
                    const neighbors = [
                        cellIdx + 1,            // Right
                        cellIdx + gridDim - 1,  // Top-Left
                        cellIdx + gridDim,      // Top
                        cellIdx + gridDim + 1   // Top-Right
                    ];

                    for (let n = 0; n < neighbors.length; n++) {
                        const neighborIdx = neighbors[n];
                        if (neighborIdx >= 0 && neighborIdx < totalGridCells) {
                            const ncx = neighborIdx % gridDim;
                            if (Math.abs(ncx - cx) <= 1) {
                                const otherAnts = collisionGrid[neighborIdx];
                                for (let i = 0; i < cellAnts.length; i++) {
                                    const a = cellAnts[i];
                                    for (let j = 0; j < otherAnts.length; j++) {
                                        const b = otherAnts[j];
                                        const dx = b.x - a.x;
                                        const dz = b.z - a.z;
                                        const distSq = dx * dx + dz * dz;

                                        if (distSq < minDistSq) {
                                            const dist = Math.sqrt(distSq);
                                            const overlap = (minDist - dist) * 0.5;
                                            const pushX = (dist > 0.001) ? (dx / dist) * overlap : (Math.random() - 0.5) * minDist * 0.5;
                                            const pushZ = (dist > 0.001) ? (dz / dist) * overlap : (Math.random() - 0.5) * minDist * 0.5;

                                            a.x -= pushX;
                                            a.z -= pushZ;
                                            b.x += pushX;
                                            b.z += pushZ;

                                            a.y = getTerrainHeight(a.x, a.z);
                                            b.y = getTerrainHeight(b.x, b.z);

                                            const escapeAngleA = Math.atan2(dx, dz) + Math.PI;
                                            const escapeAngleB = Math.atan2(dx, dz);
                                            a.angle = a.blendAngles(a.angle, escapeAngleA, 0.05);
                                            b.angle = b.blendAngles(b.angle, escapeAngleB, 0.05);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Update all ants
        for (let i = 0; i < this.ants.length; i++) {
            const ant = this.ants[i];
            
            // Respawn check
            if (ant.hp <= 0) {
                const mode = window.combatMode || 'respawn';
                if (mode === 'removal') {
                    this.ants.splice(i, 1);
                    i--;
                    this.createAntVisuals(this.ants.length);
                    continue;
                }
                ant.x = this.nestX;
                ant.z = this.nestZ;
                ant.y = getTerrainHeight(this.nestX, this.nestZ);
                ant.hp = 100;
                ant.state = 'explore';
                ant.pheromoneStrength = 1.0;
                ant.combatTarget = null;
                ant.angle = Math.random() * Math.PI * 2;
            }
            
            // 1. Steering & Movement
            ant.steer(pheromones, this.nestX, this.nestZ, this.foods, this.sensorAngle, this.sensorDistance, this.antSpeed, allColonies, this.colonyId, freeFoodAvailable);
            ant.move(this.antSpeed * 0.1, worldSize);
            
            // Obstacle physical collisions
            for (let j = 0; j < this.obstacles.length; j++) {
                const obs = this.obstacles[j];
                const dx = ant.x - obs.x;
                const dz = ant.z - obs.z;
                const distSq = dx * dx + dz * dz;
                const minDist = obs.radius + 0.35; // Obstacle radius + ant body boundary
                const minDistSq = minDist * minDist;
                
                if (distSq < minDistSq) {
                    const dist = Math.sqrt(distSq);
                    // Push out
                    const pushX = (dist > 0.001) ? (dx / dist) * (minDist - dist) : (Math.random() - 0.5) * minDist * 0.5;
                    const pushZ = (dist > 0.001) ? (dz / dist) * (minDist - dist) : (Math.random() - 0.5) * minDist * 0.5;
                    
                    ant.x += pushX;
                    ant.z += pushZ;
                    ant.y = getTerrainHeight(ant.x, ant.z);
                    
                    // Deflect away from obstacle
                    ant.angle = Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.5;
                }
            }
            
            ant.depositPheromone(pheromones);
            
            // 2. Resource Interaction Check
            if (ant.state === 'explore') {
                // Check if ant is touching any food source
                let gathered = false;
                for (let j = 0; j < this.foods.length; j++) {
                    const food = this.foods[j];
                    if (food.amount <= 0) continue;
                    
                    const dx = food.x - ant.x;
                    const dz = food.z - ant.z;
                    const dist = Math.sqrt(dx*dx + dz*dz);
                    
                    if (dist < 2.0) { // Tightened gathering distance for crystal pile
                        // Gather Food!
                        food.amount--;
                        ant.state = 'return';
                        ant.pheromoneStrength = 1.0; // Refill deposit level
                        ant.angle += Math.PI; // Spin 180 degrees to head home
                        gathered = true;
                        if (window.playGatherSound) {
                            window.playGatherSound();
                        }
                        
                        // Scale the apple down as it gets eaten
                        const scale = 0.3 + 0.7 * (food.amount / food.maxAmount);
                        food.mesh.scale.set(scale, scale, scale);
                        
                        if (food.amount <= 0) {
                            this.scene.remove(food.mesh);
                        }
                        break;
                    }
                }

                // If no natural food is gathered, check if ant is close enough to raid an enemy nest
                if (!gathered && allColonies) {
                    for (let c = 0; c < allColonies.length; c++) {
                        const enemyCol = allColonies[c];
                        if (enemyCol.colonyId === this.colonyId || enemyCol.isGraveyard || enemyCol.foodCollected <= 0) continue;
                        
                        // Allied colonies do not raid
                        if (this.stances[enemyCol.colonyId] === 'Allied') continue;
                        
                        const dx = enemyCol.nestX - ant.x;
                        const dz = enemyCol.nestZ - ant.z;
                        const distToNest = Math.sqrt(dx*dx + dz*dz);
                        
                        if (distToNest < 2.5) {
                            // Raid success! Steal 1 food
                            enemyCol.foodCollected = Math.max(0, enemyCol.foodCollected - 1);
                            enemyCol.updateNestFoodPile(enemyCol.nestX, enemyCol.nestZ);
                            
                            ant.state = 'return';
                            ant.isCarryingStolen = true;
                            ant.pheromoneStrength = 1.0;
                            ant.angle += Math.PI; // Head back home
                            
                            if (window.playGatherSound) {
                                window.playGatherSound();
                            }
                            
                            // Push narrative event
                            if (window.statsEngine) {
                                const ownName = this.colonyId === 0 ? "Green" : this.colonyId === 1 ? "Blue" : this.colonyId === 2 ? "Gold" : "Colony " + this.colonyId;
                                const enemyName = enemyCol.colonyId === 0 ? "Green" : enemyCol.colonyId === 1 ? "Blue" : enemyCol.colonyId === 2 ? "Gold" : "Colony " + enemyCol.colonyId;
                                window.statsEngine.pushEvent('raid', `💥 ${ownName} colony raided ${enemyName} nest and stole food!`, `raid_${this.colonyId}_${enemyCol.colonyId}`, 15000);
                            }
                            break;
                        }
                    }
                }
            } else {
                // State: return. Check if ant is back in Nest area
                const dx = this.nestX - ant.x;
                const dz = this.nestZ - ant.z;
                const distToNest = Math.sqrt(dx*dx + dz*dz);
                
                if (distToNest < 2.5) {
                    // Deposit food!
                    this.foodCollected++;
                    if (ant.isCarryingStolen) {
                        this.foodStolen = (this.foodStolen || 0) + 1;
                        ant.isCarryingStolen = false;
                    }
                    this.updateNestFoodPile(ant.x, ant.z);
                    ant.state = 'explore';
                    ant.pheromoneStrength = 1.0; // Refill deposit level
                    ant.angle += Math.PI; // Turn back out to search
                    if (window.playDepositSound) {
                        window.playDepositSound();
                    }
                }
            }
            
            // 3. Compute Instanced Transformation Matrix
            dummy.position.set(ant.x, ant.y + 0.3, ant.z);
            
            // Tilt and orient the ant mesh based on terrain slope (smoothly lerp normals to eliminate orientation jitter)
            const delta = 1.2;
            const hL = getTerrainHeight(ant.x - delta, ant.z);
            const hR = getTerrainHeight(ant.x + delta, ant.z);
            const hD = getTerrainHeight(ant.x, ant.z - delta);
            const hU = getTerrainHeight(ant.x, ant.z + delta);

            const targetNormal = this._scratchNormal.set(hL - hR, 2 * delta, hD - hU).normalize();
            if (!ant.normal) {
                ant.normal = new THREE.Vector3(0, 1, 0);
            }
            ant.normal.lerp(targetNormal, 0.15);
            const normal = ant.normal;

            const dirX = Math.sin(ant.angle);
            const dirZ = Math.cos(ant.angle);
            const forward = this._scratchForward.set(dirX, 0, dirZ).normalize();

            const right = this._scratchRight.crossVectors(forward, normal).normalize();
            const adjustedForward = this._scratchAdjFwd.crossVectors(normal, right).normalize();

            const rotMatrix = this._scratchRotMat.makeBasis(right, normal, adjustedForward);
            dummy.rotation.setFromRotationMatrix(rotMatrix);

            dummy.updateMatrix();
            this.instancedMesh.setMatrixAt(i, dummy.matrix);

            // Position small red food chunk on returning ants, hide otherwise
            if (ant.state === 'return') {
                this.foodCarriedMesh.setMatrixAt(i, dummy.matrix);
            } else {
                this.foodCarriedMesh.setMatrixAt(i, this._hiddenDummy.matrix);
            }
            
            // Set Color based on signature colony color (unchanged when carrying food)
            this.instancedMesh.setColorAt(i, colorForaging);
        }
        
        // Hide unused/surplus instances in the pool
        for (let i = this.ants.length; i < this.instancedMesh.count; i++) {
            this.instancedMesh.setMatrixAt(i, this._hiddenDummy.matrix);
            this.foodCarriedMesh.setMatrixAt(i, this._hiddenDummy.matrix);
        }
        
        this.instancedMesh.instanceMatrix.needsUpdate = true;
        this.foodCarriedMesh.instanceMatrix.needsUpdate = true;
        if (this.instancedMesh.instanceColor) {
            this.instancedMesh.instanceColor.needsUpdate = true;
        }
        
        // Clean up empty food piles in place (ONLY run on primary colonyId === 0 to preserve references)
        if (this.colonyId === 0) {
            for (let idx = this.foods.length - 1; idx >= 0; idx--) {
                const f = this.foods[idx];
                if (f.amount <= 0) {
                    if (f.mesh.parent) this.scene.remove(f.mesh);
                    this.foods.splice(idx, 1);
                }
            }
        }
    }
    
    reset() {
        this.ants.forEach(ant => {
            ant.x = this.nestX;
            ant.z = this.nestZ;
            ant.y = getTerrainHeight(this.nestX, this.nestZ);
            ant.state = 'explore';
            ant.pheromoneStrength = 1.0;
            ant.angle = Math.random() * Math.PI * 2;
        });
        
        // Clear food pile group
        if (this.foodPileGroup) {
            while (this.foodPileGroup.children.length > 0) {
                const child = this.foodPileGroup.children[0];
                this.foodPileGroup.remove(child);
                child.geometry.dispose();
                child.material.dispose();
            }
        }
        
        // Only primary colony clears visual meshes and shared arrays in-place
        if (this.colonyId === 0) {
            this.foods.forEach(f => {
                if (f.mesh.parent) this.scene.remove(f.mesh);
            });
            this.foods.length = 0;
            
            this.obstacles.forEach(obs => {
                if (obs.mesh.parent) this.scene.remove(obs.mesh);
            });
            this.obstacles.length = 0;
        }
        
        this.foodCollected = 0;
        this.foodStolen = 0;
        this.foodPileData = [];
        this.updateNestFoodPile();
    }
}
