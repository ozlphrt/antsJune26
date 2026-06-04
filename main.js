/**
 * Main Application Orchestrator
 */

import { getTerrainHeight, createTerrainMesh, randomizeTerrainSeed, setNestPositionsForTerrain } from './terrain.js';
import { PheromoneGrid } from './pheromones.js';
import { ColonyManager } from './colony.js';
import { StatsEngine } from './stats.js';

// Simulation Constants
const WORLD_SIZE = 120;
const INITIAL_ANTS = 250;
const PHEROMONE_RES = 128;
const COLONY_NAMES = ['Green', 'Blue', 'Gold', 'Purple', 'Teal', 'Lime'];


// Three.js Scene Variables
let scene, camera, renderer, controls;
let terrainMesh, ambientLight, dirLight;
let nests = [];
let highlightRing; // Selection ring for followed ant
const cameraLookTarget = new THREE.Vector3(); // Persistent look-at vector for camera smoothing
let lastTime = 0;
let frameCount = 0;
let fpsTimer = 0;
let combatParticles;
window.combatMode = 'removal'; // Global combat scenario mode: 'respawn', 'removal', 'conversion'
let prevColonyDefeated = []; // Track previous values to animate changes
let initialTotalPopulation = 0; // Starting total population of all active colonies
window.statsEngine = new StatsEngine(); // Global stats engine
let activeIntelTab = 'overview'; // Active dashboard tab
let selectedNestIndex = -1; // Index of the currently selected nest (-1 if none)
let lastPredictionTitle = ''; // Track last displayed prediction for toast popups
let lastIntelUpdateTime = 0; // Throttle intel dashboard rendering to prevent flickering
let colonySetupStrategies = {}; // Cache of colony personalities and stances
let selectedSetupColonyId = 0; // Currently selected colony index in setup panel




// High-performance combat particle system using points
class CombatParticleSystem {
    constructor(scene, maxParticles = 600) {
        this.scene = scene;
        this.maxParticles = maxParticles;
        this.particles = [];
        this.currentIndex = 0;
        
        const geometry = new THREE.BufferGeometry();
        this.positions = new Float32Array(maxParticles * 3);
        this.colors = new Float32Array(maxParticles * 3);
        
        // Offscreen hiding at initialization
        for (let i = 0; i < maxParticles; i++) {
            this.positions[i*3] = 9999;
            this.positions[i*3+1] = 9999;
            this.positions[i*3+2] = 9999;
        }
        
        geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
        
        const material = new THREE.PointsMaterial({
            size: 0.6,
            vertexColors: true,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        
        this.points = new THREE.Points(geometry, material);
        this.scene.add(this.points);
    }
    
    spawn(x, y, z, color1, color2) {
        const count = 6 + Math.floor(Math.random() * 6);
        const c1 = new THREE.Color(color1);
        const c2 = new THREE.Color(color2);
        
        for (let i = 0; i < count; i++) {
            const idx = this.currentIndex;
            this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
            
            const angle = Math.random() * Math.PI * 2;
            const horizSpeed = 1.0 + Math.random() * 3.0;
            const vx = Math.sin(angle) * horizSpeed;
            const vy = 1.5 + Math.random() * 3.5;
            const vz = Math.cos(angle) * horizSpeed;
            const col = Math.random() > 0.5 ? c1 : c2;
            
            this.particles[idx] = {
                x: x,
                y: y + 0.1,
                z: z,
                vx: vx,
                vy: vy,
                vz: vz,
                life: 1.0,
                decay: 1.5 + Math.random() * 2.0,
                color: col
            };
        }
    }

    spawnBlood(x, y, z) {
        const count = 12 + Math.floor(Math.random() * 8);
        const bloodColor = new THREE.Color(0xb91c1c); // Deep crimson red
        
        for (let i = 0; i < count; i++) {
            const idx = this.currentIndex;
            this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
            
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.random() * Math.PI * 0.5; // Upward hemisphere spray
            const speed = 1.5 + Math.random() * 3.5;
            
            const vx = Math.cos(theta) * Math.sin(phi) * speed;
            const vy = Math.cos(phi) * speed + 1.2;
            const vz = Math.sin(theta) * Math.sin(phi) * speed;
            
            this.particles[idx] = {
                x: x,
                y: y + 0.2,
                z: z,
                vx: vx,
                vy: vy,
                vz: vz,
                life: 1.0,
                decay: 2.2 + Math.random() * 1.5, // Fades quickly
                color: bloodColor
            };
        }
    }
    
    update(dt) {
        const posAttr = this.points.geometry.attributes.position;
        const colAttr = this.points.geometry.attributes.color;
        
        for (let i = 0; i < this.maxParticles; i++) {
            const p = this.particles[i];
            if (p && p.life > 0) {
                p.life -= dt * p.decay;
                p.vy -= 9.8 * dt; // Gravity
                
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.z += p.vz * dt;
                
                posAttr.setXYZ(i, p.x, p.y, p.z);
                colAttr.setXYZ(i, p.color.r * p.life, p.color.g * p.life, p.color.b * p.life);
                
                if (p.life <= 0) {
                    posAttr.setXYZ(i, 9999, 9999, 9999);
                }
            } else {
                posAttr.setXYZ(i, 9999, 9999, 9999);
            }
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
    }
}


// Simulation System Instances
let colonies = [];
let pheromoneGrids = [];
let pheromoneOverlays = []; // Overlay meshes that project pheromones onto terrain
let floatingHealthBags = []; // Floating health bag meshes when ants are defeated
const sharedFoods = [];
const sharedObstacles = [];

// UI State
let isPlacingFood = false;
let followAntMode = false;
let cameraPresetMode = 'default';
let initialTotalFood = 0; // Total food spawned initially + custom food placed
let lastCombatCentroid = new THREE.Vector3();
let combatCooldownTimer = 0; // cinematic delay to keep camera focused on battle zone
let isTransitioningCamera = false; // flag to enable smooth glide transition to default view
const transitionTargetPos = new THREE.Vector3();
const transitionTargetLook = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// 6 distinct colors avoiding red and pink entirely
const COLONY_CONFIGS = [
    {
        name: "Colony A (Green)",
        explore: 0x166534, // Forest Green
        carrying: 0x4ade80, // Mint Green
        pheromoneHome: [22, 101, 52],
        pheromoneFood: [74, 222, 128]
    },
    {
        name: "Colony B (Blue)",
        explore: 0x1d4ed8, // Cobalt Blue
        carrying: 0x60a5fa, // Light Sky Blue
        pheromoneHome: [29, 78, 216],
        pheromoneFood: [96, 165, 250]
    },
    {
        name: "Colony C (Gold)",
        explore: 0xca8a04, // Dark Gold
        carrying: 0xfacc15, // Bright Yellow Gold
        pheromoneHome: [202, 138, 4],
        pheromoneFood: [250, 204, 21]
    },
    {
        name: "Colony D (Purple)",
        explore: 0x6d28d9, // Violet Purple
        carrying: 0xc084fc, // Soft Lavender
        pheromoneHome: [109, 40, 217],
        pheromoneFood: [192, 132, 252]
    },
    {
        name: "Colony E (Teal)",
        explore: 0x0f766e, // Dark Teal
        carrying: 0x2dd4bf, // Bright Turquoise
        pheromoneHome: [15, 118, 110],
        pheromoneFood: [45, 212, 191]
    },
    {
        name: "Colony F (Lime)",
        explore: 0x4d7c0f, // Olive/Lime Green
        carrying: 0xa3e635, // Neon Lime
        pheromoneHome: [77, 124, 15],
        pheromoneFood: [163, 230, 53]
    }
];

let activeColonyCount = 3;

/// Helper to generate random nest positions spaced at least 32 units apart (scaled down slightly for many nests)
function generateRandomNestPositions(count) {
    const nestPositions = [];
    const minDistance = count > 4 ? 26.0 : 32.0;
    const boundary = 45.0; // Keep nests within [-45, 45] to avoid extreme edges

    for (let i = 0; i < count; i++) {
        let x, z, valid;
        let attempts = 0;
        do {
            valid = true;
            x = (Math.random() - 0.5) * (boundary * 2);
            z = (Math.random() - 0.5) * (boundary * 2);
            
            // Check distance to previously generated nests
            for (let j = 0; j < nestPositions.length; j++) {
                const dx = x - nestPositions[j].x;
                const dz = z - nestPositions[j].z;
                const dist = Math.sqrt(dx*dx + dz*dz);
                if (dist < minDistance) {
                    valid = false;
                    break;
                }
            }
            attempts++;
            if (attempts > 1000) {
                break;
            }
        } while (!valid);
        
        nestPositions.push({ x: x, z: z, core: COLONY_CONFIGS[i].explore });
    }
    return nestPositions;
}

// Automatically adjusts camera position and OrbitControls to frame all nests beautifully
function adjustCameraToFrameNests(instant = false) {
    if (!colonies || colonies.length < 2) return;
    
    // 1. Calculate center of the nests
    const center = new THREE.Vector3();
    colonies.forEach(col => {
        center.x += col.nestX;
        center.z += col.nestZ;
    });
    center.x /= colonies.length;
    center.z /= colonies.length;
    center.y = getTerrainHeight(center.x, center.z);
    
    // 2. Find max distance from center to any nest
    let maxDist = 0;
    colonies.forEach(col => {
        const dx = col.nestX - center.x;
        const dz = col.nestZ - center.z;
        const dist = Math.sqrt(dx*dx + dz*dz);
        if (dist > maxDist) maxDist = dist;
    });
    
    // Add some padding for the nest mesh volume (mesh size is ~3.6)
    const boundingRadius = maxDist + 5.0;
    
    // 3. Compute distance needed to frame the bounding radius
    const fovRad = (camera.fov * Math.PI) / 180;
    const aspect = camera.aspect || (window.innerWidth / window.innerHeight);
    
    // Calculate required distance based on FOV and aspect ratio
    let distance = boundingRadius / Math.sin(fovRad / 2);
    if (aspect < 1.0) {
        distance = distance / aspect;
    }
    
    // Apply safety margin/padding multiplier (e.g., 0.95 for a closer view)
    distance = Math.max(25, distance * 0.95);
    
    // 4. Position camera at a lower angle (30 degrees pitch above terrain at max)
    const angle = 30 * Math.PI / 180;
    const camHeight = Math.sin(angle) * distance;
    const camDepth = Math.cos(angle) * distance;
    
    const targetPos = new THREE.Vector3(center.x, center.y + camHeight, center.z + camDepth);
    const targetLook = center.clone();
    
    if (instant) {
        camera.position.copy(targetPos);
        controls.target.copy(targetLook);
        cameraLookTarget.copy(targetLook);
        camera.lookAt(targetLook);
        controls.update();
    } else {
        transitionTargetPos.copy(targetPos);
        transitionTargetLook.copy(targetLook);
        isTransitioningCamera = true;
    }
}

/// Spawns a floating 3D health bag model (white box with a red cross) at battle coordinates
function spawnHealthBag(x, y, z) {
    const group = new THREE.Group();
    
    // 1. White first-aid box base (larger for maximum visibility)
    const bagGeom = new THREE.BoxGeometry(1.8, 1.35, 1.0);
    const bagMat = new THREE.MeshStandardMaterial({ 
        color: 0xffffff,
        roughness: 0.2,
        metalness: 0.1,
        flatShading: true
    });
    const bag = new THREE.Mesh(bagGeom, bagMat);
    bag.castShadow = true;
    group.add(bag);
    
    // 2. Intersecting red cross components
    const crossHorizGeom = new THREE.BoxGeometry(1.1, 0.35, 1.05);
    const crossVertGeom = new THREE.BoxGeometry(0.35, 1.1, 1.05);
    const crossMat = new THREE.MeshStandardMaterial({ 
        color: 0xef4444,
        roughness: 0.4,
        flatShading: true
    });
    
    const crossH = new THREE.Mesh(crossHorizGeom, crossMat);
    const crossV = new THREE.Mesh(crossVertGeom, crossMat);
    crossH.castShadow = true;
    crossV.castShadow = true;
    group.add(crossH);
    group.add(crossV);
    
    // Position slightly above terrain surface (adapted for larger volume)
    group.position.set(x, y + 0.8, z);
    scene.add(group);
    
    floatingHealthBags.push({
        mesh: group,
        age: 0,
        maxAge: 0.5, // Rises for 0.5 seconds before dissolving
        speedY: 3.5  // Floats upward at 3.5 units/sec
    });
}

function disposeColonies() {
    colonies.forEach(col => {
        if (col.instancedMesh) {
            scene.remove(col.instancedMesh);
            col.instancedMesh.geometry.dispose();
            col.instancedMesh.material.dispose();
        }
        if (col.foodCarriedMesh) {
            scene.remove(col.foodCarriedMesh);
            col.foodCarriedMesh.geometry.dispose();
            col.foodCarriedMesh.material.dispose();
        }
        col.foods.forEach(food => {
            if (food.mesh) {
                scene.remove(food.mesh);
                food.mesh.children.forEach(child => {
                    child.geometry.dispose();
                    child.material.dispose();
                });
            }
        });
        col.obstacles.forEach(obs => {
            if (obs.mesh) {
                scene.remove(obs.mesh);
                obs.mesh.geometry.dispose();
                obs.mesh.material.dispose();
            }
        });
    });
    colonies = [];
    sharedFoods.length = 0;
    sharedObstacles.length = 0;
}

function rebuildScoreboardAndLegend() {
    const pillColony = document.getElementById('pill-colony-count');
    if (pillColony) {
        pillColony.innerText = activeColonyCount;
    }

    const containerDefeated = document.getElementById('container-defeated');
    if (containerDefeated) {
        containerDefeated.innerHTML = '';
        for (let i = 0; i < activeColonyCount; i++) {
            const seg = document.createElement('div');
            seg.id = `bar-defeated-${i}`;
            seg.className = `bar-segment colony-segment-${i}`;
            seg.style.width = `${100 / activeColonyCount}%`;
            
            const label = document.createElement('div');
            label.id = `defeated-text-${i}`;
            label.className = 'bar-label number-dial';
            
            const strip = document.createElement('div');
            strip.className = 'number-dial-strip';
            
            const topSlot = document.createElement('div');
            topSlot.className = 'dial-num dial-top';
            topSlot.innerText = '';
            
            const midSlot = document.createElement('div');
            midSlot.className = 'dial-num dial-mid';
            midSlot.innerText = '0';
            
            const botSlot = document.createElement('div');
            botSlot.className = 'dial-num dial-bot';
            botSlot.innerText = '';
            
            strip.appendChild(topSlot);
            strip.appendChild(midSlot);
            strip.appendChild(botSlot);
            label.appendChild(strip);
            
            seg.appendChild(label);
            containerDefeated.appendChild(seg);
        }
    }
    
    const containerFood = document.getElementById('container-food');
    if (containerFood) {
        containerFood.innerHTML = '';
        for (let i = 0; i < activeColonyCount; i++) {
            const seg = document.createElement('div');
            seg.id = `bar-food-${i}`;
            seg.className = `bar-segment colony-segment-${i}`;
            seg.style.width = '0%';
            
            const label = document.createElement('span');
            label.id = `food-text-${i}`;
            label.className = 'bar-label';
            
            seg.appendChild(label);
            containerFood.appendChild(seg);
        }
        
        const remainingSeg = document.createElement('div');
        remainingSeg.id = 'bar-food-remaining';
        remainingSeg.className = 'bar-segment red-segment';
        remainingSeg.style.width = '100%';
        
        const remainingLabel = document.createElement('span');
        remainingLabel.id = 'food-text-remaining';
        remainingLabel.className = 'bar-label';
        remainingLabel.innerText = '0';
        
        remainingSeg.appendChild(remainingLabel);
        containerFood.appendChild(remainingSeg);
    }
    
    const containerLegend = document.getElementById('container-legend');
    if (containerLegend) {
        containerLegend.innerHTML = '';
        for (let i = 0; i < activeColonyCount; i++) {
            const item = document.createElement('div');
            item.className = 'legend-item';
            
            const dot = document.createElement('span');
            dot.className = `dot ant-colony-${i}`;
            
            const text = document.createTextNode(` ${COLONY_CONFIGS[i].name}`);
            
            item.appendChild(dot);
            item.appendChild(text);
            containerLegend.appendChild(item);
        }
        
        const foodItem = document.createElement('div');
        foodItem.className = 'legend-item';
        const foodDot = document.createElement('span');
        foodDot.className = 'dot entity-food';
        const foodText = document.createTextNode(' Food Source');
        foodItem.appendChild(foodDot);
        foodItem.appendChild(foodText);
        containerLegend.appendChild(foodItem);
    }

    // Render the personality/strategy setup panel
    renderColonySetupPanel();
}

const headshotsCache = {};

function getTintedHeadshot(personality, hexColor, callback) {
    const cacheKey = `${personality}_${hexColor}`;
    if (headshotsCache[cacheKey]) {
        if (callback) callback(headshotsCache[cacheKey]);
        return headshotsCache[cacheKey];
    }

    const imgUrl = `assets/${personality}.png`;
    const img = new Image();
    img.src = imgUrl;
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        // 1. Fill with the target colony color
        ctx.fillStyle = hexColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 2. Multiply with grayscale details (boosted brightness for rich, bright color vibrancy)
        ctx.globalCompositeOperation = 'multiply';
        ctx.filter = 'grayscale(100%) contrast(0.9) brightness(2.2)';
        ctx.drawImage(img, 0, 0);

        // 3. Mask out the original background using alpha channel
        ctx.globalCompositeOperation = 'destination-in';
        ctx.filter = 'none';
        ctx.drawImage(img, 0, 0);

        const dataUrl = canvas.toDataURL();
        headshotsCache[cacheKey] = dataUrl;
        if (callback) callback(dataUrl);
    };
    img.onerror = () => {
        headshotsCache[cacheKey] = imgUrl;
        if (callback) callback(imgUrl);
    };
    // Return a blank inline SVG as placeholder while loading
    return 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
}

function renderColonySetupPanel() {
    const list = document.getElementById('setup-colonies-list');
    if (!list) return;

    // Dynamically adjust panel width to fit all active colony columns side-by-side without overlapping
    const panel = document.getElementById('colony-setup-panel');
    if (panel) {
        const dynamicWidth = 32 + (activeColonyCount * 112);
        panel.style.width = `${dynamicWidth}px`;
    }

    // Make sure strategies are initialized
    for (let i = 0; i < activeColonyCount; i++) {
        if (!colonySetupStrategies[i]) {
            const personalities = ['dove', 'hawk', 'grudger', 'bully'];
            const randomPers = personalities[Math.floor(Math.random() * personalities.length)];
            colonySetupStrategies[i] = {
                personality: randomPers,
                stances: {}
            };
        }
    }

    let columnsHtml = `<div style="display:flex; gap:6px; justify-content:space-between; width:100%; padding:4px 0;">`;

    for (let i = 0; i < activeColonyCount; i++) {
        const config = COLONY_CONFIGS[i];
        const hex = '#' + config.explore.toString(16).padStart(6, '0');
        const name = COLONY_NAMES[i] || `C${i}`;
        const strat = colonySetupStrategies[i];

        // Personality cycle details & explanation tooltip
        const pLabel = strat.personality === 'grudger' ? 'Tit-for-Tat' : (strat.personality.charAt(0).toUpperCase() + strat.personality.slice(1));
        let pTooltip = "";
        if (strat.personality === 'dove') {
            pTooltip = "Dove: Friendly & peaceful. Cooperates by default, shares food/resources, and avoids conflict.";
        } else if (strat.personality === 'hawk') {
            pTooltip = "Hawk: Highly aggressive. Attacks other colonies on sight to seize resources.";
        } else if (strat.personality === 'grudger') {
            pTooltip = "Tit-for-Tat: Retaliatory but forgiving. Starts cooperative, but copies the opponent's previous action.";
        } else if (strat.personality === 'bully') {
            pTooltip = "Bully: Exploitative but cowardly. Preys on the cooperative, but flees if countered.";
        }

        // Stances by other colonies towards this colony (i)
        let stanceDotsHtml = `<div style="display:flex; flex-wrap:wrap; gap:4px; justify-content:center; margin-top:6px; width:100%;">`;
        for (let j = 0; j < activeColonyCount; j++) {
            if (i === j) continue;
            const otherConfig = COLONY_CONFIGS[j];
            const otherHex = '#' + otherConfig.explore.toString(16).padStart(6, '0');
            const otherShortName = ['GRN', 'BLU', 'GLD', 'PRP', 'TEL', 'LIM'][j] || `C${j}`;

            if (!colonySetupStrategies[j].stances) {
                colonySetupStrategies[j].stances = {};
            }
            if (colonySetupStrategies[j].stances[i] === undefined) {
                const jPers = colonySetupStrategies[j].personality;
                if (jPers === 'hawk') {
                    colonySetupStrategies[j].stances[i] = 'Hostile';
                } else if (jPers === 'dove') {
                    colonySetupStrategies[j].stances[i] = Math.random() > 0.4 ? 'Allied' : 'Neutral';
                } else if (jPers === 'grudger') {
                    colonySetupStrategies[j].stances[i] = Math.random() > 0.5 ? 'Allied' : 'Neutral';
                } else { // bully
                    colonySetupStrategies[j].stances[i] = Math.random() > 0.5 ? 'Hostile' : 'Neutral';
                }
            }

            const stance = colonySetupStrategies[j].stances[i];
            
            // Allied: Solid green with check. Hostile: Solid red with X. Neutral: Solid dark grey.
            const bgStance = stance === 'Allied' ? '#22c55e' : stance === 'Hostile' ? '#ef4444' : 'rgba(0, 0, 0, 0.4)';
            const stanceIcon = stance === 'Allied' ? '✓' : stance === 'Hostile' ? '✕' : '•';
            const shadow = stance === 'Allied' ? '0 0 3px rgba(34, 197, 94, 0.5)' : stance === 'Hostile' ? '0 0 3px rgba(239, 68, 68, 0.5)' : 'none';

            // Explaining the stance on hover
            const stanceExplain = stance === 'Allied' 
                ? `Allied: ${COLONY_NAMES[j]} is friendly and will cooperate/share food with ${name}.` 
                : stance === 'Hostile' 
                    ? `Hostile: ${COLONY_NAMES[j]} is aggressive and will attack ${name} on sight.` 
                    : `Neutral: ${COLONY_NAMES[j]} will ignore ${name} unless attacked or provoked.`;

            stanceDotsHtml += `
                <button class="setup-stance-dot" data-from="${j}" data-to="${i}" title="${stanceExplain}" style="padding:4px 8px; border-radius:8px; background:${bgStance}; border:1px solid rgba(255,255,255,0.15); color:#fff; font-size:0.58rem; font-weight:800; font-family:'Space Grotesk', sans-serif; cursor:pointer; box-shadow:${shadow}; transition:all 0.12s ease; outline:none; white-space:nowrap; display:inline-flex; align-items:center; gap:3px;">
                    <span style="font-size:0.62rem; line-height:1; font-weight:900;">${stanceIcon}</span> ${otherShortName}
                </button>
            `;
        }
        stanceDotsHtml += `</div>`;

        columnsHtml += `
            <div style="flex:1; display:flex; flex-direction:column; align-items:center; background:none; border:none; padding:4px 0; min-width:0;">
                <!-- Personality capsule badge (closer to frame with high-contrast background) -->
                <span title="${pTooltip}" style="font-size:0.62rem; font-weight:800; background:#18181b; color:#fff; border:1.5px solid ${hex}; padding:3px 6px; border-radius:10px; text-transform:uppercase; letter-spacing:0.02em; margin-bottom:2px; box-shadow:0 1px 3px rgba(0,0,0,0.1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:95%; cursor:help;">
                    ${pLabel}
                </span>

                <!-- Clickable Ant Headshot (Cycles strategy, border only, background transparent) -->
                <button class="setup-ant-click-btn" data-col="${i}" style="background:none; border:none; padding:0; cursor:pointer; outline:none; transition:transform 0.1s ease; border-radius:10px;">
                    <div class="ant-frame" style="position:relative; margin:2px 0; width:90px; height:120px; display:flex; align-items:center; justify-content:center; background:none; border-radius:10px; border:2px solid ${hex}; transition: all 0.15s ease; --colony-color: ${hex};">
                        <img class="tint-headshot-lazy" data-personality="${strat.personality}" data-color="${hex}" style="width:82px; height:112px; object-fit:contain;" />
                    </div>
                </button>
                
                <!-- Clickable Stance Ring Dots (transformed to pills) -->
                ${stanceDotsHtml}
            </div>
        `;
    }

    columnsHtml += `</div>`;
    list.innerHTML = columnsHtml;

    // Trigger lazy tint loading
    list.querySelectorAll('.tint-headshot-lazy').forEach(img => {
        const personality = img.getAttribute('data-personality');
        const color = img.getAttribute('data-color');
        getTintedHeadshot(personality, color, (dataUrl) => {
            img.src = dataUrl;
        });
    });

    // Wire Up Cycle Events
    list.querySelectorAll('.setup-ant-click-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const colId = parseInt(btn.getAttribute('data-col'));
            const pOrder = ['dove', 'hawk', 'grudger', 'bully'];
            const currentIdx = pOrder.indexOf(colonySetupStrategies[colId].personality);
            const nextIdx = (currentIdx + 1) % pOrder.length;
            const nextPers = pOrder[nextIdx];
            colonySetupStrategies[colId].personality = nextPers;
            
            // Re-assign stances to other colonies based on new personality
            for (let j = 0; j < activeColonyCount; j++) {
                if (colId === j) continue;
                if (nextPers === 'hawk') {
                    colonySetupStrategies[colId].stances[j] = 'Hostile';
                } else if (nextPers === 'dove') {
                    colonySetupStrategies[colId].stances[j] = Math.random() > 0.4 ? 'Allied' : 'Neutral';
                } else if (nextPers === 'grudger') {
                    colonySetupStrategies[colId].stances[j] = Math.random() > 0.5 ? 'Allied' : 'Neutral';
                } else { // bully
                    colonySetupStrategies[colId].stances[j] = Math.random() > 0.5 ? 'Hostile' : 'Neutral';
                }
            }
            renderColonySetupPanel();
        });
    });

    list.querySelectorAll('.setup-stance-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.preventDefault();
            const fromCol = parseInt(dot.getAttribute('data-from'));
            const toCol = parseInt(dot.getAttribute('data-to'));
            const sOrder = ['Allied', 'Neutral', 'Hostile'];
            const currentStance = colonySetupStrategies[fromCol].stances[toCol] || 'Neutral';
            const currentIdx = sOrder.indexOf(currentStance);
            const nextIdx = (currentIdx + 1) % sOrder.length;
            colonySetupStrategies[fromCol].stances[toCol] = sOrder[nextIdx];
            renderColonySetupPanel();
        });
    });
}


function rebuildSimulation() {
    prevColonyDefeated = [];
    // 1. Clean up old elements
    nests.forEach(nest => {
        if (nest.parent) scene.remove(nest);
        nest.children.forEach(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
    });
    nests = [];
    
    floatingHealthBags.forEach(bag => {
        if (bag.mesh.parent) scene.remove(bag.mesh);
        bag.mesh.children.forEach(child => {
            child.geometry.dispose();
            child.material.dispose();
        });
    });
    floatingHealthBags = [];
    
    pheromoneOverlays.forEach(overlay => {
        if (overlay.parent) scene.remove(overlay);
        overlay.geometry.dispose();
        overlay.material.dispose();
    });
    pheromoneOverlays = [];
    pheromoneGrids = [];
    
    disposeColonies();
    
    // 2. Nest coordinates & terrain flattening
    const nestPositions = generateRandomNestPositions(activeColonyCount);
    setNestPositionsForTerrain(nestPositions);
    randomizeTerrainSeed();
    
    if (terrainMesh) {
        scene.remove(terrainMesh);
        terrainMesh.geometry.dispose();
        terrainMesh.material.dispose();
    }
    terrainMesh = createTerrainMesh(WORLD_SIZE, WORLD_SIZE, 120);
    terrainMesh.geometry.userData.defaultColors = terrainMesh.geometry.attributes.color.array.slice();
    scene.add(terrainMesh);
    
    // 3. Recreate nests
    for (let i = 0; i < activeColonyCount; i++) {
        const nestMesh = createNest(nestPositions[i].x, nestPositions[i].z, nestPositions[i].core);
        nests.push(nestMesh);
    }
    
    // 4. Recreate pheromone overlays and colony managers
    const overlayGeometry = terrainMesh.geometry.clone();
    
    const sliderAntCount = document.getElementById('control-ant-count');
    const antCount = sliderAntCount ? parseInt(sliderAntCount.value) : 250;
    
    const sliderSpeed = document.getElementById('control-ant-speed');
    const speed = sliderSpeed ? parseFloat(sliderSpeed.value) : 1.0;
    
    const sliderAngle = document.getElementById('control-sensor-angle');
    const sensorAngle = sliderAngle ? parseInt(sliderAngle.value) * Math.PI / 180 : 35 * Math.PI / 180;
    
    const sliderDist = document.getElementById('control-sensor-dist');
    const sensorDistance = sliderDist ? parseFloat(sliderDist.value) : 3.0;
    
    for (let i = 0; i < activeColonyCount; i++) {
        const config = COLONY_CONFIGS[i];
        
        // Pheromone grid
        const pGrid = new PheromoneGrid(WORLD_SIZE, PHEROMONE_RES, config.pheromoneHome, config.pheromoneFood);
        pheromoneGrids.push(pGrid);
        
        const overlayMaterial = new THREE.MeshBasicMaterial({
            map: pGrid.texture,
            transparent: true,
            opacity: 0.85, // Raised opacity to make light/mid/dark bands clearly visible
            depthWrite: false,
            blending: THREE.NormalBlending
        });
        const pheromoneOverlay = new THREE.Mesh(overlayGeometry, overlayMaterial);
        pheromoneOverlay.position.y = 0.04 + i * 0.005;
        scene.add(pheromoneOverlay);
        pheromoneOverlays.push(pheromoneOverlay);
        
        // Colony Manager
        const colManager = new ColonyManager(
            scene,
            nestPositions[i].x,
            nestPositions[i].z,
            antCount,
            i,
            config.explore,
            config.carrying,
            sharedFoods,
            sharedObstacles
        );
        colManager.antSpeed = speed;
        colManager.sensorAngle = sensorAngle;
        colManager.sensorDistance = sensorDistance;
        
        // Apply configured game theory personality and stances
        if (!colonySetupStrategies[i]) {
            const personalities = ['dove', 'hawk', 'grudger', 'bully'];
            const randomPers = personalities[Math.floor(Math.random() * personalities.length)];
            colonySetupStrategies[i] = {
                personality: randomPers,
                stances: {}
            };
        }
        colManager.personality = colonySetupStrategies[i].personality;
        colManager.stances = { ...colonySetupStrategies[i].stances };
        
        colonies.push(colManager);
    }
    
    // 5. Spawn shared elements
    initialTotalFood = spawnDefaultFood();
    spawnObstacles(40);
    
    initialTotalPopulation = colonies.reduce((sum, c) => sum + c.ants.length, 0);
    
    // 6. UI elements
    rebuildScoreboardAndLegend();
    
    // Initialize/Reset stats engine
    window.statsEngine.initColonies(colonies);
    
    // 7. View centering
    adjustCameraToFrameNests();
}

function spawnDefaultFood() {
    let totalSpawned = 0;
    for (let i = 0; i < 10; i++) {
        let x, z, dist;
        do {
            x = (Math.random() - 0.5) * (WORLD_SIZE - 20);
            z = (Math.random() - 0.5) * (WORLD_SIZE - 20);
            dist = Infinity;
            for (let c = 0; c < colonies.length; c++) {
                const dx = x - colonies[c].nestX;
                const dz = z - colonies[c].nestZ;
                const d = Math.sqrt(dx*dx + dz*dz);
                if (d < dist) dist = d;
            }
        } while (dist < 22.0);
        
        const amount = 150 + Math.floor(Math.random() * 100);
        totalSpawned += amount;
        colonies[0].addFoodSource(x, z, amount);
    }
    return totalSpawned;
}

function spawnObstacles(count) {
    const geometry = new THREE.DodecahedronGeometry(1.0, 1);
    const material = new THREE.MeshStandardMaterial({
        color: 0x78716c,
        roughness: 0.9,
        metalness: 0.1,
        flatShading: true
    });
    
    for (let i = 0; i < count; i++) {
        let x, z, dist;
        do {
            x = (Math.random() - 0.5) * (WORLD_SIZE - 20);
            z = (Math.random() - 0.5) * (WORLD_SIZE - 20);
            dist = Infinity;
            for (let c = 0; c < colonies.length; c++) {
                const dx = x - colonies[c].nestX;
                const dz = z - colonies[c].nestZ;
                const d = Math.sqrt(dx*dx + dz*dz);
                if (d < dist) dist = d;
            }
        } while (dist < 18.0);
        
        const radius = 1.2 + Math.random() * 2.2;
        const meshGeom = geometry.clone();
        meshGeom.scale(radius, radius * 1.5, radius);
        
        const mesh = new THREE.Mesh(meshGeom, material);
        const y = getTerrainHeight(x, z) - 0.3;
        mesh.position.set(x, y, z);
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        scene.add(mesh);
        colonies[0].addObstacle(x, z, radius, mesh);
    }
}

function createNest(x, z, coreColor) {
    const nestGroup = new THREE.Group();
    const yPos = getTerrainHeight(x, z);
    
    // 1. Deformed Organic Mud Mound
    const moundGeom = new THREE.SphereGeometry(2.5, 32, 24);
    const posAttr = moundGeom.attributes.position;
    
    for (let i = 0; i < posAttr.count; i++) {
        let px = posAttr.getX(i);
        let py = posAttr.getY(i);
        let pz = posAttr.getZ(i);
        
        // Shift up so bottom of the sphere is at 0
        py += 2.5;
        
        // Taper the shape to make a natural mound (wide at bottom, narrow at top)
        const heightRatio = py / 5.0; // 0 to 1
        const widthScale = (1.0 - heightRatio * 0.85);
        px *= widthScale;
        pz *= widthScale;
        
        // Add organic roughness/bumpy noise to mimic dirt/clay structure
        const angle = Math.atan2(pz, px);
        const noise = Math.sin(angle * 5) * Math.cos(py * 2.0) * 0.15 + Math.cos(angle * 3) * 0.1;
        px += (px !== 0 ? px / Math.abs(px) : 0) * noise;
        pz += (pz !== 0 ? pz / Math.abs(pz) : 0) * noise;
        
        // Create crater depression at the top center
        if (heightRatio > 0.80) {
            const distFromCenter = Math.sqrt(px * px + pz * pz);
            py -= (0.8 - distFromCenter) * 0.9;
        }
        
        posAttr.setXYZ(i, px, py, pz);
    }
    moundGeom.computeVertexNormals();
    
    const moundMat = new THREE.MeshStandardMaterial({
        color: 0x483c32, // Natural dark taupe/mud clay
        roughness: 0.95,
        metalness: 0.05,
        flatShading: true // Faceted look to mimic packed organic earth and stone clumps
    });
    
    const mound = new THREE.Mesh(moundGeom, moundMat);
    mound.castShadow = true;
    mound.receiveShadow = true;
    nestGroup.add(mound);
    
    // 2. Inner Bioluminescent Pool (inside crater)
    const poolGeom = new THREE.SphereGeometry(0.7, 16, 12);
    const poolMat = new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: coreColor,
        emissiveIntensity: 4.0,
        roughness: 0.1,
        metalness: 0.1
    });
    const pool = new THREE.Mesh(poolGeom, poolMat);
    pool.position.y = 4.0;
    nestGroup.add(pool);
    
    // 3. Glowing Point Light (illuminates the environment and crater)
    const nestLight = new THREE.PointLight(coreColor, 4.0, 15);
    nestLight.position.set(0, 4.2, 0);
    nestLight.castShadow = true;
    nestLight.shadow.bias = -0.002;
    nestGroup.add(nestLight);
    
    // 4. Bioluminescent Mushrooms on slopes
    const mushroomCaps = [];
    const mushroomCount = 3 + Math.floor(Math.random() * 2); // 3 to 4 mushrooms
    
    for (let j = 0; j < mushroomCount; j++) {
        const angle = (j * Math.PI * 2) / mushroomCount + Math.random() * 0.4;
        const height = 0.8 + Math.random() * 1.2; // lower to mid mound
        
        const heightRatio = height / 5.0;
        const baseRadius = 2.5 * (1.0 - heightRatio * 0.85);
        const mx = Math.cos(angle) * (baseRadius - 0.1);
        const mz = Math.sin(angle) * (baseRadius - 0.1);
        
        // Mushroom stem
        const stemHeight = 0.4 + Math.random() * 0.3;
        const stemGeom = new THREE.CylinderGeometry(0.06, 0.08, stemHeight, 6);
        const stemMat = new THREE.MeshStandardMaterial({
            color: 0xd6cda4, // Pale beige stem
            roughness: 0.8,
            metalness: 0.05
        });
        const stem = new THREE.Mesh(stemGeom, stemMat);
        stem.position.set(mx, height, mz);
        
        // Tilt stem pointing outward and slightly upward
        stem.rotation.z = -Math.cos(angle) * 0.55;
        stem.rotation.x = Math.sin(angle) * 0.55;
        nestGroup.add(stem);
        
        // Mushroom glowing cap
        const capGeom = new THREE.ConeGeometry(0.25, 0.28, 8);
        const capMat = new THREE.MeshStandardMaterial({
            color: 0x000000,
            emissive: coreColor,
            emissiveIntensity: 3.5,
            roughness: 0.3,
            metalness: 0.1
        });
        const cap = new THREE.Mesh(capGeom, capMat);
        
        // Position cap at stem tip
        const offsetDir = new THREE.Vector3(Math.cos(angle), 1.0, Math.sin(angle)).normalize();
        cap.position.set(
            mx + offsetDir.x * (stemHeight * 0.5),
            height + offsetDir.y * (stemHeight * 0.5),
            mz + offsetDir.z * (stemHeight * 0.5)
        );
        cap.rotation.z = stem.rotation.z;
        cap.rotation.x = stem.rotation.x;
        
        nestGroup.add(cap);
        mushroomCaps.push(cap);
    }
    
    // Store animated references in userData
    nestGroup.userData = {
        pool: pool,
        light: nestLight,
        mushroomCaps: mushroomCaps
    };
    
    nestGroup.position.set(x, yPos, z);
    scene.add(nestGroup);
    
    return nestGroup;
}

function createGraveyard(x, z) {
    const graveGroup = new THREE.Group();
    const yPos = getTerrainHeight(x, z);
    
    // 1. Dark, ruined grey/black collapsed organic mound
    const moundGeom = new THREE.SphereGeometry(2.2, 16, 12);
    moundGeom.scale(1.0, 0.4, 1.0); // Collapse shape
    const moundMat = new THREE.MeshStandardMaterial({
        color: 0x27272a, // Zinc dark charcoal
        roughness: 0.95,
        flatShading: true
    });
    const mound = new THREE.Mesh(moundGeom, moundMat);
    mound.castShadow = true;
    mound.receiveShadow = true;
    graveGroup.add(mound);
    
    // 2. Add 2-3 weathered stone tombstones/headstones
    const tsCount = 2 + Math.floor(Math.random() * 2);
    const tsGeom = new THREE.BoxGeometry(0.35, 0.65, 0.12);
    tsGeom.translate(0, 0.325, 0); // Offset pivot
    
    const tsMat = new THREE.MeshStandardMaterial({
        color: 0x52525b, // Zinc weathered grey
        roughness: 0.9,
        flatShading: true
    });
    
    for (let i = 0; i < tsCount; i++) {
        const ts = new THREE.Mesh(tsGeom, tsMat);
        ts.castShadow = true;
        
        const angle = (i * Math.PI * 2) / tsCount + (Math.random() - 0.5) * 0.4;
        const radius = 0.5 + Math.random() * 0.7;
        const tx = Math.cos(angle) * radius;
        const tz = Math.sin(angle) * radius;
        const ty = 0.05 + Math.random() * 0.15;
        
        ts.position.set(tx, ty, tz);
        ts.rotation.x = (Math.random() - 0.5) * 0.3;
        ts.rotation.z = (Math.random() - 0.5) * 0.3;
        ts.rotation.y = Math.random() * Math.PI * 2;
        
        const scale = 0.8 + Math.random() * 0.4;
        ts.scale.set(scale, scale, scale);
        
        graveGroup.add(ts);
    }
    
    // 3. Rubble stone chunks
    const chunkGeom = new THREE.DodecahedronGeometry(0.16, 0);
    for (let i = 0; i < 4; i++) {
        const chunk = new THREE.Mesh(chunkGeom, tsMat);
        chunk.position.set(
            (Math.random() - 0.5) * 2.2,
            0.05,
            (Math.random() - 0.5) * 2.2
        );
        chunk.rotation.set(Math.random(), Math.random(), Math.random());
        graveGroup.add(chunk);
    }
    
    // Explicitly initialize empty userData to avoid animation loop type-errors
    graveGroup.userData = {};
    graveGroup.position.set(x, yPos, z);
    
    return graveGroup;
}

function init() {
    const container = document.getElementById('canvas-container');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xebebed);
    scene.fog = new THREE.Fog(0xebebed, 200, 450);
    
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 50, 75);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.minDistance = 5;
    controls.maxDistance = 150;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.45;
    
    // Cancel camera autotransitions if user interacts manually
    controls.addEventListener('start', () => {
        isTransitioningCamera = false;
    });
    
    ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambientLight);
    
    dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(50, 100, 30);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 200;
    const d = 80;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
    
    const ringGeom = new THREE.TorusGeometry(0.7, 0.05, 8, 24);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xd97706,
        depthTest: false
    });
    highlightRing = new THREE.Mesh(ringGeom, ringMat);
    highlightRing.rotation.x = Math.PI / 2;
    highlightRing.visible = false;
    scene.add(highlightRing);
    
    let audioCtx = null;
    let audioEnabled = false; // Muted by default to ensure browser compliance and clean start
    let lastDefeatSoundTime = 0;
    
    function initAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    window.playDefeatSound = () => {
        if (!audioEnabled) return;
        const now = Date.now();
        if (now - lastDefeatSoundTime < 600) return; // Prevent rapid noisy overlapping
        lastDefeatSoundTime = now;
        
        try {
            initAudio();
            if (!audioCtx || audioCtx.state === 'suspended') return;
            
            // Soft wood-like pop/crunch pluck
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(140, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
            
            gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
            
            osc.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            
            osc.start();
            osc.stop(audioCtx.currentTime + 0.16);
        } catch(e) {}
    };

    window.playKickSound = () => {
        if (!audioEnabled) return;
        try {
            initAudio();
            if (!audioCtx || audioCtx.state === 'suspended') return;
            
            // Pleasant, soft organic chime/plop
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(320, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(220, audioCtx.currentTime + 0.12);
            
            gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.04, audioCtx.currentTime + 0.01);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
            
            osc.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            
            osc.start();
            osc.stop(audioCtx.currentTime + 0.13);
        } catch(e) {}
    };

    window.addEventListener('pointerdown', initAudio, { once: true });
    window.addEventListener('touchstart', initAudio, { once: true });
    window.addEventListener('click', initAudio, { once: true });
    window.addEventListener('touchend', initAudio, { once: true });

    combatParticles = new CombatParticleSystem(scene);
    window.spawnCombatSparks = (x, y, z, c1, c2) => {
        combatParticles.spawn(x, y, z, c1, c2);
    };
    window.spawnBloodSplash = (x, y, z) => {
        combatParticles.spawnBlood(x, y, z);
        window.playDefeatSound();
    };
    window.spawnHealthBag = (x, y, z) => {
        spawnHealthBag(x, y, z);
        window.playKickSound();
    };
 
    rebuildSimulation();
    setupUI();
    applyCameraPreset('default');
    
    // Ensure initial placement is instantly set without sliding
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('pointerdown', onCanvasClick);
    
    // Position floating nest card dynamically to follow the cursor
    window.addEventListener('mousemove', (e) => {
        if (selectedNestIndex !== -1) {
            const card = document.getElementById('nest-stats-card');
            if (card && !card.classList.contains('hidden')) {
                let x = e.clientX + 15;
                let y = e.clientY + 15;
                if (x + 270 > window.innerWidth) x = e.clientX - 280;
                if (y + 250 > window.innerHeight) y = e.clientY - 260;
                card.style.left = `${x}px`;
                card.style.top = `${y}px`;
            }
        }
    });
    
    requestAnimationFrame(animate);
}

function setupUI() {
    const sliderColonyCount = document.getElementById('control-colony-count');
    const valColonyCount = document.getElementById('val-colony-count');
    const popupColonyCount = document.getElementById('popup-colony-count');
    const valPopupColonyCount = document.getElementById('val-popup-colony-count');

    function updateColonyCount(count) {
        sliderColonyCount.value = count;
        valColonyCount.innerText = count;
        popupColonyCount.value = count;
        valPopupColonyCount.innerText = count;
        activeColonyCount = count;
        rebuildSimulation();
    }

    sliderColonyCount.addEventListener('input', (e) => {
        updateColonyCount(parseInt(e.target.value));
    });
    popupColonyCount.addEventListener('input', (e) => {
        updateColonyCount(parseInt(e.target.value));
    });

    const sliderAntCount = document.getElementById('control-ant-count');
    const valAntCount = document.getElementById('val-ant-count');
    const popupAntCount = document.getElementById('popup-ant-count');
    const valPopupAntCount = document.getElementById('val-popup-ant-count');

    function updateAntCount(count) {
        sliderAntCount.value = count;
        valAntCount.innerText = count;
        popupAntCount.value = count;
        valPopupAntCount.innerText = count;
        colonies.forEach(c => c.setPopulation(count));
    }

    sliderAntCount.addEventListener('input', (e) => {
        updateAntCount(parseInt(e.target.value));
    });
    popupAntCount.addEventListener('input', (e) => {
        updateAntCount(parseInt(e.target.value));
    });
    
    const sliderSpeed = document.getElementById('control-ant-speed');
    const valSpeed = document.getElementById('val-ant-speed');
    sliderSpeed.addEventListener('input', (e) => {
        const speed = parseFloat(e.target.value);
        valSpeed.innerText = speed.toFixed(1);
        colonies.forEach(c => c.antSpeed = speed);
    });
    
    const sliderEvaporation = document.getElementById('control-evaporation');
    const valEvaporation = document.getElementById('val-evaporation');
    sliderEvaporation.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valEvaporation.innerText = val.toFixed(3);
        pheromoneGrids.forEach(p => p.decayRate = val);
    });
    
    const sliderAngle = document.getElementById('control-sensor-angle');
    const valAngle = document.getElementById('val-sensor-angle');
    sliderAngle.addEventListener('input', (e) => {
        const deg = parseInt(e.target.value);
        valAngle.innerText = deg + '°';
        colonies.forEach(c => c.sensorAngle = deg * Math.PI / 180);
    });
    
    const sliderDist = document.getElementById('control-sensor-dist');
    const valDist = document.getElementById('val-sensor-dist');
    sliderDist.addEventListener('input', (e) => {
        const dist = parseFloat(e.target.value);
        valDist.innerText = dist.toFixed(1);
        colonies.forEach(c => c.sensorDistance = dist);
    });
    
    const btnOrbit = document.getElementById('btn-camera-orbit');
    const btnFollow = document.getElementById('btn-camera-follow');
    
    btnOrbit.addEventListener('click', () => {
        followAntMode = false;
        cameraPresetMode = 'default';
        btnOrbit.classList.add('active');
        btnFollow.classList.remove('active');
        controls.enabled = true;
        document.querySelectorAll('.preset-option-btn').forEach(btn => {
            if (btn.getAttribute('data-preset') === 'default') btn.classList.add('active');
            else btn.classList.remove('active');
        });
    });
    
    btnFollow.addEventListener('click', () => {
        followAntMode = true;
        cameraPresetMode = 'ant';
        btnFollow.classList.add('active');
        btnOrbit.classList.remove('active');
        controls.enabled = false;
        document.querySelectorAll('.preset-option-btn').forEach(btn => {
            if (btn.getAttribute('data-preset') === 'ant') btn.classList.add('active');
            else btn.classList.remove('active');
        });
    });
    
    const btnSpawnFood = document.getElementById('btn-spawn-food');
    btnSpawnFood.addEventListener('click', (e) => {
        e.stopPropagation();
        isPlacingFood = !isPlacingFood;
        if (isPlacingFood) {
            btnSpawnFood.classList.add('waiting-click');
            btnSpawnFood.innerText = 'Click on Terrain...';
        } else {
            btnSpawnFood.classList.remove('waiting-click');
            btnSpawnFood.innerText = 'Add Food Cluster';
        }
    });
    
    const btnReset = document.getElementById('btn-reset');
    btnReset.addEventListener('click', () => {
        rebuildSimulation();
        isPlacingFood = false;
        btnSpawnFood.classList.remove('waiting-click');
        btnSpawnFood.innerText = 'Add Food Cluster';
    });

    const btnApplySetup = document.getElementById('btn-apply-setup');
    if (btnApplySetup) {
        btnApplySetup.addEventListener('click', () => {
            rebuildSimulation();
        });
    }


    const btnCamera = document.getElementById('btn-camera-preset');
    const cameraMenu = document.getElementById('camera-preset-menu');
    const btnSettings = document.getElementById('btn-settings-toggle');
    const dashboard = document.querySelector('.dashboard');
    const btnColonyPill = document.getElementById('btn-colony-pill');
    const panelColonyEdit = document.getElementById('panel-colony-edit');
    const btnAntPill = document.getElementById('btn-ant-pill');
    const panelAntEdit = document.getElementById('panel-ant-edit');
    const btnCombatPill = document.getElementById('btn-combat-pill');
    const panelCombatEdit = document.getElementById('panel-combat-edit');
    const pillCombatMode = document.getElementById('pill-combat-mode');
    const btnRestartPill = document.getElementById('btn-restart-pill');
    const btnAudioPill = document.getElementById('btn-audio-pill');
    const pillAudioIcon = document.getElementById('pill-audio-icon');
    const pillAudioText = document.getElementById('pill-audio-text');
    
    btnCamera.addEventListener('click', (e) => {
        e.stopPropagation();
        cameraMenu.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
    });
    
    btnSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        dashboard.classList.toggle('hidden');
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
    });

    btnColonyPill.addEventListener('click', (e) => {
        e.stopPropagation();
        panelColonyEdit.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        cameraMenu.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
    });

    btnAntPill.addEventListener('click', (e) => {
        e.stopPropagation();
        panelAntEdit.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
    });

    btnCombatPill.addEventListener('click', (e) => {
        e.stopPropagation();
        panelCombatEdit.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
    });

    const intelPanel = document.getElementById('intel-panel');
    const btnIntelPin = document.getElementById('btn-intel-pin');
    const intelHoverTrigger = document.getElementById('intel-hover-trigger');

    if (btnIntelPin && intelPanel && intelHoverTrigger) {
        btnIntelPin.addEventListener('click', (e) => {
            e.stopPropagation();
            intelPanel.classList.toggle('pinned');
            if (!intelPanel.classList.contains('pinned')) {
                intelPanel.classList.add('hidden');
            } else {
                intelPanel.classList.remove('hidden');
            }
        });

        intelHoverTrigger.addEventListener('mouseenter', () => {
            if (!intelPanel.classList.contains('pinned')) {
                intelPanel.classList.remove('hidden');
            }
        });

        intelPanel.addEventListener('mouseleave', () => {
            if (!intelPanel.classList.contains('pinned')) {
                intelPanel.classList.add('hidden');
            }
        });
    }

    // Wire up Intel tab selectors
    document.querySelectorAll('.intel-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.intel-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const selectedTab = btn.getAttribute('data-tab');
            activeIntelTab = selectedTab;

            document.querySelectorAll('.intel-tab-content').forEach(content => {
                if (content.id === `tab-${selectedTab}`) {
                    content.classList.remove('hidden');
                } else {
                    content.classList.add('hidden');
                }
            });
            lastIntelUpdateTime = 0; // Force immediate render
            renderIntelDashboard();
        });
    });

    // Close overlays on document click
    document.addEventListener('click', () => {
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
    });

    // Prevent propagation inside panel clicks
    intelPanel.addEventListener('click', (e) => e.stopPropagation());

    btnRestartPill.addEventListener('click', (e) => {
        e.stopPropagation();
        rebuildSimulation();
        // Close menus
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
        dashboard.classList.add('hidden');
    });

    btnAudioPill.addEventListener('click', (e) => {
        e.stopPropagation();
        initAudio();
        audioEnabled = !audioEnabled;
        if (audioEnabled) {
            pillAudioIcon.innerText = '🔊';
            pillAudioText.innerText = 'Sound On';
            btnAudioPill.style.backgroundColor = 'rgba(16, 185, 129, 0.15)'; // subtle green highlight
            window.playKickSound(); // pleasant startup chime
        } else {
            pillAudioIcon.innerText = '🔇';
            pillAudioText.innerText = 'Muted';
            btnAudioPill.style.backgroundColor = '';
        }
        // Close other panels
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
        dashboard.classList.add('hidden');
    });

    panelColonyEdit.addEventListener('click', (e) => e.stopPropagation());
    panelAntEdit.addEventListener('click', (e) => e.stopPropagation());
    panelCombatEdit.addEventListener('click', (e) => e.stopPropagation());
    
    window.addEventListener('click', () => {
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
        panelCombatEdit.classList.add('hidden');
    });
    
    document.querySelectorAll('.preset-option-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const preset = btn.getAttribute('data-preset');
            applyCameraPreset(preset);
            cameraMenu.classList.add('hidden');
        });
    });

    document.querySelectorAll('.combat-option-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.combat-option-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const mode = btn.getAttribute('data-mode');
            window.combatMode = mode;
            
            // Capitalize first letter for pill display
            pillCombatMode.innerText = mode.charAt(0).toUpperCase() + mode.slice(1);
            panelCombatEdit.classList.add('hidden');
        });
    });

    const btnNestClose = document.getElementById('btn-nest-card-close');
    if (btnNestClose) {
        btnNestClose.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedNestIndex = -1;
            document.getElementById('nest-stats-card').classList.add('hidden');
        });
    }
};


// Raycast to place food sources or select nests on canvas click
function onCanvasClick(event) {
    // Calculate normalized mouse coordinates (-1 to 1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);

    if (isPlacingFood) {
        const intersects = raycaster.intersectObject(terrainMesh);
        if (intersects.length > 0) {
            const pt = intersects[0].point;
            colonies[0].addFoodSource(pt.x, pt.z, 250); // Adds to shared foods list
            initialTotalFood += 250;
            
            // Reset Placement Mode
            isPlacingFood = false;
            const btnSpawnFood = document.getElementById('btn-spawn-food');
            btnSpawnFood.classList.remove('waiting-click');
            btnSpawnFood.innerText = 'Add Food Cluster';
        }
        return;
    }

    // Check if a Nest mesh was clicked
    const intersects = raycaster.intersectObjects(nests, true);
    if (intersects.length > 0) {
        let hitObj = intersects[0].object;
        let nestIndex = -1;
        while (hitObj) {
            nestIndex = nests.indexOf(hitObj);
            if (nestIndex !== -1) break;
            hitObj = hitObj.parent;
        }

        if (nestIndex !== -1) {
            showNestStatsCard(nestIndex, event.clientX, event.clientY);
        }
    } else {
        // Hide card if clicking empty space
        const nestCard = document.getElementById('nest-stats-card');
        if (nestCard) {
            nestCard.classList.add('hidden');
        }
        selectedNestIndex = -1;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Simulation loop
function animate(time) {
    requestAnimationFrame(animate);
    
    // Calculate delta time
    const dt = Math.min(0.03, (time - lastTime) / 1000);
    lastTime = time;
    
    // FPS counter calculation
    frameCount++;
    fpsTimer += dt;
    if (fpsTimer >= 1.0) {
        document.getElementById('stat-fps').innerText = Math.round(frameCount / fpsTimer);
        frameCount = 0;
        fpsTimer = 0;
    }
    
    // 1. Update Core Simulation Systems
    for (let i = 0; i < activeColonyCount; i++) {
        if (pheromoneGrids[i] && colonies[i]) {
            pheromoneGrids[i].update();
            colonies[i].update(pheromoneGrids[i], WORLD_SIZE, colonies);
            
            // Check for colony defeat (graveyard conversion when population falls to 0)
            if (colonies[i].ants.length === 0 && !colonies[i].isGraveyard && initialTotalPopulation > 0) {
                colonies[i].isGraveyard = true;
                const nest = nests[i];
                if (nest) {
                    scene.remove(nest);
                    nest.children.forEach(child => {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) child.material.dispose();
                    });
                    
                    // Remove the food pile from the scene and dispose of resources
                    if (colonies[i].foodPileGroup) {
                        scene.remove(colonies[i].foodPileGroup);
                        colonies[i].foodPileGroup.children.forEach(child => {
                            child.geometry.dispose();
                            child.material.dispose();
                        });
                        colonies[i].foodPileGroup = null;
                    }
                    
                    const grave = createGraveyard(colonies[i].nestX, colonies[i].nestZ);
                    scene.add(grave);
                    nests[i] = grave;
                }
            }
        }
    }
    
    // Update combat visual feedback particles
    if (combatParticles) {
        combatParticles.update(dt);
    }
    
    // 2. Nest Animations (organic breathing pulse of bioluminescent pool and mushrooms)
    nests.forEach((nest) => {
        const pulse = 3.0 + Math.sin(time * 0.003) * 1.5;
        if (nest.userData) {
            if (nest.userData.light) {
                nest.userData.light.intensity = pulse;
            }
            if (nest.userData.pool && nest.userData.pool.material) {
                nest.userData.pool.material.emissiveIntensity = pulse;
            }
            if (nest.userData.mushroomCaps) {
                nest.userData.mushroomCaps.forEach((cap) => {
                    if (cap.material) {
                        // Pulsate cap light with a slight offset phase based on its 3D position
                        const offset = cap.position.x * 2.0 + cap.position.z * 2.0;
                        cap.material.emissiveIntensity = 2.5 + Math.sin(time * 0.004 + offset) * 1.5;
                    }
                });
            }
        }
    });
    
    // 3. Camera Controls / Tracking Update
    if (isTransitioningCamera) {
        camera.position.lerp(transitionTargetPos, 0.04);
        controls.target.lerp(transitionTargetLook, 0.04);
        controls.update();
        if (camera.position.distanceTo(transitionTargetPos) < 0.1 && 
            controls.target.distanceTo(transitionTargetLook) < 0.1) {
            isTransitioningCamera = false;
        }
    } else if (cameraPresetMode === 'ant' && colonies[0] && colonies[0].ants.length > 0) {
        const trackingColony = colonies[0];
        const antMatrix = new THREE.Matrix4();
        trackingColony.instancedMesh.getMatrixAt(0, antMatrix);
        
        const antPos = new THREE.Vector3();
        const antQuat = new THREE.Quaternion();
        const antScale = new THREE.Vector3();
        antMatrix.decompose(antPos, antQuat, antScale);
        
        // Center highlight ring on terrain surface under tracked ant
        highlightRing.position.copy(antPos);
        highlightRing.position.y -= 0.26;
        
        const trackingAnt = trackingColony.ants[0];
        const terrainNormal = trackingAnt.normal || new THREE.Vector3(0, 1, 0);
        const ringNormal = new THREE.Vector3(0, 0, 1);
        highlightRing.quaternion.setFromUnitVectors(ringNormal, terrainNormal);
        
        // Spin ring
        if (highlightRing.userData.spin === undefined) highlightRing.userData.spin = 0;
        highlightRing.userData.spin += dt * 2.5;
        highlightRing.rotateZ(highlightRing.userData.spin);
        highlightRing.visible = true;
        
        // Follow cam (zoomed out: y+11.0, z+16.0 instead of y+7.0, z+11.0)
        const targetCamPos = new THREE.Vector3(antPos.x, antPos.y + 11.0, antPos.z + 16.0);
        camera.position.lerp(targetCamPos, 0.04);
        cameraLookTarget.lerp(antPos, 0.04);
        camera.lookAt(cameraLookTarget);
        
        // Sync controls target so switching back to orbit controls is seamless
        controls.target.copy(antPos);
    } else if (cameraPresetMode === 'battle') {
        if (highlightRing) highlightRing.visible = false;
        
        // Find active battles
        const activeFights = [];
        for (let c = 0; c < colonies.length; c++) {
            const col = colonies[c];
            for (let a = 0; a < col.ants.length; a++) {
                const ant = col.ants[a];
                if (ant.combatTarget && ant.hp > 0 && ant.combatTarget.hp > 0) {
                    activeFights.push({ x: ant.x, y: ant.y, z: ant.z });
                }
            }
        }
        
        if (activeFights.length > 0) {
            // Calculate the centroid (average position) of all active battles
            const centroid = new THREE.Vector3();
            activeFights.forEach(fight => {
                centroid.x += fight.x;
                centroid.y += fight.y;
                centroid.z += fight.z;
            });
            centroid.divideScalar(activeFights.length);
            
            // Record target and reset cooldown
            lastCombatCentroid.copy(centroid);
            combatCooldownTimer = 4.0; 
        } else if (combatCooldownTimer > 0) {
            combatCooldownTimer -= dt;
        }

        // Build list of target points that must stay in the viewport
        const framePoints = [];
        
        if (combatCooldownTimer > 0) {
            // Combat is active: zoom in close to the combat zone
            // 1. Add combat centroid
            framePoints.push(new THREE.Vector3(lastCombatCentroid.x, lastCombatCentroid.y, lastCombatCentroid.z));
            
            // 2. Add only the single nest closest to the combat zone
            let closestNest = null;
            let minDist = Infinity;
            colonies.forEach(col => {
                const dist = lastCombatCentroid.distanceTo(new THREE.Vector3(col.nestX, getTerrainHeight(col.nestX, col.nestZ), col.nestZ));
                if (dist < minDist) {
                    minDist = dist;
                    closestNest = col;
                }
            });
            if (closestNest) {
                framePoints.push(new THREE.Vector3(closestNest.nestX, getTerrainHeight(closestNest.nestX, closestNest.nestZ), closestNest.nestZ));
            }
            
            // 3. Add only the food source closest to the combat zone
            if (sharedFoods && sharedFoods.length > 0) {
                let bestFood = null;
                let minFoodDist = Infinity;
                sharedFoods.forEach(food => {
                    if (food.amount > 0) {
                        const dist = lastCombatCentroid.distanceTo(new THREE.Vector3(food.x, 0, food.z));
                        if (dist < minFoodDist) {
                            minFoodDist = dist;
                            bestFood = food;
                        }
                    }
                });
                if (bestFood) {
                    framePoints.push(new THREE.Vector3(bestFood.x, getTerrainHeight(bestFood.x, bestFood.z), bestFood.z));
                }
            }
        } else {
            // No combat: frame all nests and the nearest food source (wide overview)
            // 1. Always include all nests
            colonies.forEach(col => {
                framePoints.push(new THREE.Vector3(col.nestX, getTerrainHeight(col.nestX, col.nestZ), col.nestZ));
            });
            
            // 2. Include closest food source to center of nests
            if (sharedFoods && sharedFoods.length > 0) {
                const nestsCenter = new THREE.Vector3();
                colonies.forEach(col => nestsCenter.add(new THREE.Vector3(col.nestX, 0, col.nestZ)));
                nestsCenter.divideScalar(colonies.length);
                
                let bestFood = null;
                let minDist = Infinity;
                sharedFoods.forEach(food => {
                    if (food.amount > 0) {
                        const dist = nestsCenter.distanceTo(new THREE.Vector3(food.x, 0, food.z));
                        if (dist < minDist) {
                            minDist = dist;
                            bestFood = food;
                        }
                    }
                });
                if (bestFood) {
                    framePoints.push(new THREE.Vector3(bestFood.x, getTerrainHeight(bestFood.x, bestFood.z), bestFood.z));
                }
            }
        }

        // Calculate centroid of all required targets
        const targetLookAt = new THREE.Vector3();
        framePoints.forEach(p => targetLookAt.add(p));
        targetLookAt.divideScalar(framePoints.length);

        // Find maximum radius enclosing all targets
        let maxDist = 0;
        framePoints.forEach(p => {
            const dist = targetLookAt.distanceTo(p);
            if (dist > maxDist) maxDist = dist;
        });
        const boundingRadius = maxDist + 8.0; // Comfort padding margin

        // Compute correct camera depth from FOV and aspect ratio
        const fovRad = (camera.fov * Math.PI) / 180;
        const aspect = camera.aspect || (window.innerWidth / window.innerHeight);
        let distance = boundingRadius / Math.sin(fovRad / 2);
        if (aspect < 1.0) {
            distance = distance / aspect;
        }
        distance = Math.max(18, distance * 0.55);

        // Position camera relative to target centroid at a nice low overview pitch angle (22 degrees)
        // Preserve current horizontal angle to enable silky smooth auto-spin rotation
        const angle = 22 * Math.PI / 180;
        const camHeight = Math.sin(angle) * distance;
        const camDepth = Math.cos(angle) * distance;

        const offsetVec = new THREE.Vector3().subVectors(camera.position, targetLookAt);
        const horizDir = new THREE.Vector3(offsetVec.x, 0, offsetVec.z).normalize();
        if (horizDir.lengthSq() === 0) horizDir.set(0, 0, 1);

        const targetCamPos = new THREE.Vector3(
            targetLookAt.x + horizDir.x * camDepth,
            targetLookAt.y + camHeight,
            targetLookAt.z + horizDir.z * camDepth
        );

        // Glides very slowly to focus center (lerp 0.008 for cinematic smoothness)
        camera.position.lerp(targetCamPos, 0.008);
        controls.target.lerp(targetLookAt, 0.008);
        controls.update();
    } else {
        if (highlightRing) highlightRing.visible = false;
        controls.update();
    }
    // 4. Update HUD Statistics scoreboard dynamically
    let totalCollected = 0;
    const colonyFood = [];
    const colonyScoreValue = [];
    let totalScoreValue = 0;
    
    const showDefeatedMode = (window.combatMode === 'respawn');
    const scoreTitleElem = document.getElementById('scoreboard-title-defeated');
    if (scoreTitleElem) {
        scoreTitleElem.innerText = showDefeatedMode ? "Defeated" : "Population";
    }
    
    for (let i = 0; i < activeColonyCount; i++) {
        const collected = colonies[i] ? colonies[i].foodCollected : 0;
        colonyFood.push(collected);
        totalCollected += collected;
        
        let scoreVal = 0;
        if (colonies[i]) {
            scoreVal = showDefeatedMode ? colonies[i].antsDefeated : colonies[i].ants.length;
        }
        colonyScoreValue.push(scoreVal);
        totalScoreValue += scoreVal;
    }
    
    // Scoreboard top row segments update
    const containerDefeated = document.getElementById('container-defeated');
    if (containerDefeated) {
        containerDefeated.style.width = '100%';
    }
    
    function updateNumberDial(dialElem, newVal, prevVal) {
        if (!dialElem) return;
        const strip = dialElem.querySelector('.number-dial-strip');
        if (!strip) return;
        
        const topSlot = strip.querySelector('.dial-top');
        const midSlot = strip.querySelector('.dial-mid');
        const botSlot = strip.querySelector('.dial-bot');
        
        if (prevVal === undefined) {
            midSlot.innerText = newVal;
            topSlot.innerText = newVal + 1;
            botSlot.innerText = Math.max(0, newVal - 1);
            strip.style.transition = 'none';
            strip.style.transform = 'translateY(-6px)';
            return;
        }
        
        if (prevVal === newVal) {
            return;
        }
        
        if (strip.classList.contains('roll-animating')) {
            // Cancel current animation cleanly
            strip.style.transition = 'none';
            topSlot.style.transition = 'none';
            midSlot.style.transition = 'none';
            botSlot.style.transition = 'none';
            
            midSlot.innerText = newVal;
            topSlot.innerText = newVal + 1;
            botSlot.innerText = Math.max(0, newVal - 1);
            
            midSlot.style.opacity = '';
            midSlot.style.transform = '';
            topSlot.style.opacity = '';
            topSlot.style.transform = '';
            botSlot.style.opacity = '';
            botSlot.style.transform = '';
            
            strip.style.transform = 'translateY(-6px)';
            strip.classList.remove('roll-animating');
            return;
        }
        
        const duration = '850ms';
        const ease = 'cubic-bezier(0.16, 1, 0.28, 1)'; // Ultra-premium ultra-soft easing
        
        if (newVal < prevVal) {
            botSlot.innerText = newVal;
            topSlot.innerText = prevVal;
            
            // Setup initial animation frame
            strip.style.transition = 'none';
            topSlot.style.transition = 'none';
            midSlot.style.transition = 'none';
            botSlot.style.transition = 'none';
            
            strip.style.transform = 'translateY(-6px)';
            topSlot.style.opacity = '0';
            midSlot.style.opacity = '1';
            midSlot.style.transform = 'scale(1)';
            botSlot.style.opacity = '0';
            botSlot.style.transform = 'scale(0.82)';
            
            void strip.offsetWidth; // Force layout
            
            strip.classList.add('roll-animating');
            strip.style.transition = `transform ${duration} ${ease}`;
            strip.style.transform = 'translateY(-18px)';
            
            midSlot.style.transition = `opacity ${duration} ${ease}, transform ${duration} ${ease}`;
            midSlot.style.opacity = '0';
            midSlot.style.transform = 'scale(0.82)';
            
            botSlot.style.transition = `opacity ${duration} ${ease}, transform ${duration} ${ease}`;
            botSlot.style.opacity = '1';
            botSlot.style.transform = 'scale(1)';
            
            setTimeout(() => {
                // Remove transitions before text swap to prevent visual jump/flicker
                strip.style.transition = 'none';
                topSlot.style.transition = 'none';
                midSlot.style.transition = 'none';
                botSlot.style.transition = 'none';
                
                midSlot.innerText = newVal;
                topSlot.innerText = newVal + 1;
                botSlot.innerText = Math.max(0, newVal - 1);
                
                midSlot.style.opacity = '';
                midSlot.style.transform = '';
                botSlot.style.opacity = '';
                botSlot.style.transform = '';
                topSlot.style.opacity = '';
                topSlot.style.transform = '';
                
                strip.style.transform = 'translateY(-6px)';
                void strip.offsetHeight; // Force layout repaint
                strip.classList.remove('roll-animating');
            }, 850);
        } else {
            topSlot.innerText = newVal;
            botSlot.innerText = prevVal;
            
            // Setup initial animation frame
            strip.style.transition = 'none';
            topSlot.style.transition = 'none';
            midSlot.style.transition = 'none';
            botSlot.style.transition = 'none';
            
            strip.style.transform = 'translateY(-6px)';
            botSlot.style.opacity = '0';
            midSlot.style.opacity = '1';
            midSlot.style.transform = 'scale(1)';
            topSlot.style.opacity = '0';
            topSlot.style.transform = 'scale(0.82)';
            
            void strip.offsetWidth; // Force layout
            
            strip.classList.add('roll-animating');
            strip.style.transition = `transform ${duration} ${ease}`;
            strip.style.transform = 'translateY(6px)';
            
            midSlot.style.transition = `opacity ${duration} ${ease}, transform ${duration} ${ease}`;
            midSlot.style.opacity = '0';
            midSlot.style.transform = 'scale(0.82)';
            
            topSlot.style.transition = `opacity ${duration} ${ease}, transform ${duration} ${ease}`;
            topSlot.style.opacity = '1';
            topSlot.style.transform = 'scale(1)';
            
            setTimeout(() => {
                // Remove transitions before text swap to prevent visual jump/flicker
                strip.style.transition = 'none';
                topSlot.style.transition = 'none';
                midSlot.style.transition = 'none';
                botSlot.style.transition = 'none';
                
                midSlot.innerText = newVal;
                topSlot.innerText = newVal + 1;
                botSlot.innerText = Math.max(0, newVal - 1);
                
                midSlot.style.opacity = '';
                midSlot.style.transform = '';
                topSlot.style.opacity = '';
                topSlot.style.transform = '';
                botSlot.style.opacity = '';
                botSlot.style.transform = '';
                
                strip.style.transform = 'translateY(-6px)';
                void strip.offsetHeight; // Force layout repaint
                strip.classList.remove('roll-animating');
            }, 850);
        }
    }

    for (let i = 0; i < activeColonyCount; i++) {
        let scorePct = 100 / activeColonyCount;
        if (totalScoreValue > 0) {
            scorePct = (colonyScoreValue[i] / totalScoreValue) * 100;
        }
        const barSeg = document.getElementById(`bar-defeated-${i}`);
        const labelText = document.getElementById(`defeated-text-${i}`);
        
        const prevVal = prevColonyDefeated[i];
        const newVal = colonyScoreValue[i];
        
        if (barSeg && labelText) {
            barSeg.style.width = scorePct + '%';
            labelText.style.opacity = scorePct > 4 ? '1' : '0';
            updateNumberDial(labelText, newVal, prevVal);
        }
        prevColonyDefeated[i] = newVal;
    }
    
    // Food segments update
    const totalAvailableFood = sharedFoods.reduce((sum, f) => sum + f.amount, 0);
    const totalFoodInGame = totalCollected + totalAvailableFood;
    
    let foodPctRemaining = 100;
    if (totalFoodInGame > 0) {
        foodPctRemaining = (totalAvailableFood / totalFoodInGame) * 100;
    }
    
    for (let i = 0; i < activeColonyCount; i++) {
        let foodPct = 0;
        if (totalFoodInGame > 0) {
            foodPct = (colonyFood[i] / totalFoodInGame) * 100;
        }
        const barSeg = document.getElementById(`bar-food-${i}`);
        const labelText = document.getElementById(`food-text-${i}`);
        if (barSeg && labelText) {
            barSeg.style.width = foodPct + '%';
            labelText.innerText = foodPct > 6 ? colonyFood[i] : "";
        }
    }
    
    const barRemaining = document.getElementById('bar-food-remaining');
    const labelRemaining = document.getElementById('food-text-remaining');
    if (barRemaining && labelRemaining) {
        barRemaining.style.width = foodPctRemaining + '%';
        labelRemaining.innerText = foodPctRemaining > 6 ? totalAvailableFood : "";
    }
    
    const totalAnts = colonies.reduce((sum, c) => sum + c.ants.length, 0);
    document.getElementById('stat-ants').innerText = totalAnts;
    const pillAnt = document.getElementById('pill-ant-count');
    if (pillAnt) {
        pillAnt.innerText = totalAnts;
    }
    
    const totalForaging = colonies.reduce((sum, c) => sum + c.ants.filter(a => a.state === 'explore').length, 0);
    document.getElementById('stat-foraging').innerText = totalForaging;
    
    // Update Stats Engine & Live Ticker
    if (window.statsEngine) {
        window.statsEngine.update(colonies, terrainMesh, dt);


        // Update stats card if visible
        if (selectedNestIndex !== -1) {
            updateNestStatsCard();
        }
        
        // Render Intel Dashboard if visible (throttled to 200ms to eliminate flickering)
        const intelPanel = document.getElementById('intel-panel');
        if (intelPanel && !intelPanel.classList.contains('hidden')) {
            const now = Date.now();
            if (now - lastIntelUpdateTime > 200) {
                renderIntelDashboard();
                lastIntelUpdateTime = now;
            }
        }
    }
    
    // 5. Update floating health bags
    for (let i = floatingHealthBags.length - 1; i >= 0; i--) {
        const bag = floatingHealthBags[i];
        bag.age += dt;
        
        // Rise upward
        bag.mesh.position.y += bag.speedY * dt;
        
        // Spin slowly for a dynamic look
        bag.mesh.rotation.y += dt * 2.0;
        
        // Shrink and fade out as age approaches maximum lifetime
        const progress = bag.age / bag.maxAge;
        const scale = 1.0 - progress;
        bag.mesh.scale.set(scale, scale, scale);
        
        // Remove and dispose Three.js meshes/materials when dead
        if (bag.age >= bag.maxAge) {
            scene.remove(bag.mesh);
            bag.mesh.children.forEach(child => {
                child.geometry.dispose();
                child.material.dispose();
            });
            floatingHealthBags.splice(i, 1);
        }
    }
    
    // 6. Smoothly paint terrain red locally around active combat
    const activeFights = [];
    for (let c = 0; c < colonies.length; c++) {
        const col = colonies[c];
        for (let a = 0; a < col.ants.length; a++) {
            const ant = col.ants[a];
            if (ant.combatTarget && ant.hp > 0 && ant.combatTarget.hp > 0) {
                activeFights.push({ x: ant.x, z: ant.z });
            }
        }
    }
    
    if (terrainMesh && terrainMesh.geometry) {
        const colorAttr = terrainMesh.geometry.attributes.color;
        const colors = colorAttr.array;
        const defaults = terrainMesh.geometry.userData.defaultColors;
        
        if (defaults) {
            const posAttr = terrainMesh.geometry.attributes.position;
            const vertexCount = posAttr.count;
            let needsUpdate = false;
            
            for (let i = 0; i < vertexCount; i++) {
                const vx = posAttr.getX(i);
                const vz = posAttr.getZ(i);
                
                let minDistSq = Infinity;
                for (let f = 0; f < activeFights.length; f++) {
                    const dx = vx - activeFights[f].x;
                    const dz = vz - activeFights[f].z;
                    const distSq = dx * dx + dz * dz;
                    if (distSq < minDistSq) {
                        minDistSq = distSq;
                    }
                }
                
                const idx = i * 3;
                const rDefault = defaults[idx];
                const gDefault = defaults[idx+1];
                const bDefault = defaults[idx+2];
                
                let targetR = rDefault;
                let targetG = gDefault;
                let targetB = bDefault;
                
                // Paint local region within 2.0 units of combat (focused) and with 75% blend intensity
                if (minDistSq < 4.0) { 
                    const dist = Math.sqrt(minDistSq);
                    const intensity = Math.max(0, 1.0 - dist / 2.0) * 0.75;
                    targetR = rDefault * (1 - intensity) + 1.0 * intensity;
                    targetG = gDefault * (1 - intensity) + 0.15 * intensity;
                    targetB = bDefault * (1 - intensity) + 0.15 * intensity;
                }
                
                const diffR = targetR - colors[idx];
                const diffG = targetG - colors[idx+1];
                const diffB = targetB - colors[idx+2];
                
                if (Math.abs(diffR) > 0.001 || Math.abs(diffG) > 0.001 || Math.abs(diffB) > 0.001) {
                    colors[idx] += diffR * 0.12;
                    colors[idx+1] += diffG * 0.12;
                    colors[idx+2] += diffB * 0.12;
                    needsUpdate = true;
                }
            }
            
            if (needsUpdate) {
                colorAttr.needsUpdate = true;
            }
        }
    }
    
    // Render Scene
    renderer.render(scene, camera);
}

function renderIntelDashboard() {
    if (!window.statsEngine) return;

    // ── Shared helpers ──────────────────────────────────────────
    const getColName = (colId) => COLONY_NAMES[colId] !== undefined ? COLONY_NAMES[colId] : `C${colId}`;

    // Build a colony pill badge: filled bg, white dot, white text
    const colPill = (colId, hexColor) => {
        const r = parseInt(hexColor.slice(1,3),16);
        const g = parseInt(hexColor.slice(3,5),16);
        const b = parseInt(hexColor.slice(5,7),16);
        return `<span class="col-pill" style="background:${hexColor};color:#fff;border:1.5px solid rgba(255,255,255,0.2);">
                  <span class="dot" style="background:rgba(255,255,255,0.55);"></span>${getColName(colId)}</span>`;
    };

    // Inline colony pill (light tinted bg, colored text) for use in white-bg rows
    const colPillLight = (colId, hexColor) => {
        const r = parseInt(hexColor.slice(1,3),16);
        const g = parseInt(hexColor.slice(3,5),16);
        const b = parseInt(hexColor.slice(5,7),16);
        return `<span class="col-pill" style="background:rgba(${r},${g},${b},0.12);color:${hexColor};border:1.5px solid rgba(${r},${g},${b},0.3);">
                  <span class="dot" style="background:${hexColor};"></span>${getColName(colId)}</span>`;
    };

    // Compact colony pill (dot + abbreviated name) for matrix / narrow spaces
    const colPillCompact = (colId, hexColor, light = false) => {
        const shortNames = ['GRN', 'BLU', 'GLD', 'PRP', 'TEL', 'LIM'];
        const name = shortNames[colId] || `C${colId}`;
        const r = parseInt(hexColor.slice(1,3),16);
        const g = parseInt(hexColor.slice(3,5),16);
        const b = parseInt(hexColor.slice(5,7),16);
        if (light) {
            return `<span class="col-pill compact" style="background:rgba(${r},${g},${b},0.12);color:${hexColor};border:1px solid rgba(${r},${g},${b},0.3);">
                      <span class="dot" style="background:${hexColor};"></span>${name}</span>`;
        } else {
            return `<span class="col-pill compact" style="background:${hexColor};color:#fff;border:1px solid rgba(255,255,255,0.2);">
                      <span class="dot" style="background:rgba(255,255,255,0.55);"></span>${name}</span>`;
        }
    };

    // HP distribution bar + legend
    const hpBarHtml = (buckets) => {
        const tot = buckets.reduce((a,b)=>a+b,0)||1;
        const p = buckets.map(b=>(b/tot*100).toFixed(1));
        return `<div class="hp-bar-wrap">
          <div class="hp-seg-bar">
            <div style="width:${p[0]}%;background:#ef4444;"></div>
            <div style="width:${p[1]}%;background:#f97316;"></div>
            <div style="width:${p[2]}%;background:#eab308;"></div>
            <div style="width:${p[3]}%;background:#22c55e;"></div>
          </div>
          <div class="hp-legend">
            <span class="hp-legend-item" style="color:#ef4444;" title="Critical: 0–25% HP"><span class="hp-legend-dot" style="background:#ef4444;"></span>Crit ${Math.round(p[0])}%</span>
            <span class="hp-legend-item" style="color:#f97316;" title="Low: 26–50% HP"><span class="hp-legend-dot" style="background:#f97316;"></span>Low ${Math.round(p[1])}%</span>
            <span class="hp-legend-item" style="color:#eab308;" title="Mid: 51–75% HP"><span class="hp-legend-dot" style="background:#eab308;"></span>Mid ${Math.round(p[2])}%</span>
            <span class="hp-legend-item" style="color:#22c55e;" title="Full: 76–100% HP"><span class="hp-legend-dot" style="background:#22c55e;"></span>Full ${Math.round(p[3])}%</span>
          </div>
        </div>`;
    };

    // Sparkline SVG
    const sparklineHtml = (data, color, uid) => {
        if (!data || data.length < 2) return `<div style="height:38px;background:rgba(0,0,0,0.03);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:#aaa;">no data yet</div>`;
        const W=258, H=38;
        const maxV=Math.max(...data,1), minV=Math.min(...data,0);
        const range=maxV-minV||1;
        const xs=data.map((_,i)=>(i/(data.length-1))*W);
        const ys=data.map(v=>H-3-((v-minV)/range)*(H-6));
        const pts=xs.map((x,i)=>`${x},${ys[i]}`);
        const areaD=`M${pts[0]} L${pts.join(' L')} L${W},${H} L0,${H} Z`;
        const gid=`sg_${uid}`;
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:38px;" preserveAspectRatio="none">
          <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient></defs>
          <path d="${areaD}" fill="url(#${gid})"/>
          <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="${xs[xs.length-1]}" cy="${ys[ys.length-1]}" r="2.5" fill="${color}" opacity="0.9"/>
        </svg>`;
    };

    // ── OVERVIEW TAB ────────────────────────────────────────────
    if (activeIntelTab === 'overview') {
        const container = document.getElementById('tab-overview');
        if (!container) return;

        const initPerColony = initialTotalPopulation > 0 ? Math.round(initialTotalPopulation / colonies.length) : 100;
        const totalFood = colonies.reduce((s,c)=>s+c.foodCollected,0);
        const intensity = window.statsEngine.battleIntensity || 0;

        // Intensity color
        const iColor = intensity < 30 ? '#22c55e' : intensity < 65 ? '#f97316' : '#ef4444';
        const iLabel = intensity < 15 ? 'Quiet' : intensity < 35 ? 'Skirmish' : intensity < 65 ? 'Moderate' : intensity < 85 ? 'High' : '🔥 Intense';

        let html = '';

        // ── Section: Colony Population at a Glance ──
        html += `<div class="intel-widget">
          <div class="intel-section-title">⚡ Colony Status</div>`;

        colonies.forEach(c => {
            const hex = '#' + c.exploreColor.getHexString();
            const r = Math.round(c.exploreColor.r * 255);
            const g = Math.round(c.exploreColor.g * 255);
            const b = Math.round(c.exploreColor.b * 255);
            const risk = c.extinctionRisk || 0;
            const slope = c.populationSlope || 0;
            const trendIcon = slope > 0.2 ? '↑' : slope < -0.2 ? '↓' : '→';
            const trendColor = slope > 0.2 ? '#22c55e' : slope < -0.2 ? '#ef4444' : '#71717a';
            const hp = c.hpBuckets || [0,0,0,10];
            const hpTot = hp.reduce((a,b)=>a+b,0)||1;
            const healthScore = Math.round(((hp[2]+hp[3])/hpTot)*100);
            const aggPct = Math.round((c.aggressionIndex||0)*100);
            const threat = c.nearestThreatDist||9999;
            const threatPct = threat<9999 ? Math.round(Math.max(0,(1-threat/60))*100) : 0;
            let riskClass='risk-low', riskText='Stable';
            if (risk>=70){riskClass='risk-high';riskText='Critical!';}
            else if (risk>=40){riskClass='risk-medium';riskText='Vulnerable';}

            html += `<div class="vitals-colony-block">
              <div class="vitals-header">
                <div style="display:flex; align-items:center; gap:6px;">
                  ${colPill(c.colonyId, hex)}
                  <span style="font-size:0.52rem; font-weight:800; background:rgba(0,0,0,0.05); color:var(--text-secondary); padding:1px 4px; border-radius:4px; display:inline-flex; align-items:center; gap:3px; text-transform:uppercase;">
                    <img class="tint-headshot-lazy" data-personality="${c.personality || 'dove'}" data-color="${hex}" style="width: 10px; height: 10px; object-fit: contain;" />
                    ${c.personality === 'grudger' ? 'Tit-for-Tat' : (c.personality || 'dove')}
                  </span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;">
                  <span style="font-size:0.62rem;font-weight:700;color:${trendColor};">${trendIcon} ${slope>0?'+':''}${slope.toFixed(1)}/s</span>
                  <span class="risk-badge ${riskClass}">${riskText}</span>
                </div>
              </div>
              <div class="vitals-stats-row">
                <div class="vitals-stat-cell">
                  <div class="vitals-stat-num" style="color:${hex};">${c.ants.length}</div>
                  <div class="vitals-stat-label">Ants</div>
                </div>
                <div class="vitals-stat-cell">
                  <div class="vitals-stat-num">${healthScore}%</div>
                  <div class="vitals-stat-label">Health</div>
                </div>
                <div class="vitals-stat-cell">
                  <div class="vitals-stat-num">${aggPct}%</div>
                  <div class="vitals-stat-label">Combat</div>
                </div>
                <div class="vitals-stat-cell">
                  <div class="vitals-stat-num" style="color:${threatPct>60?'#ef4444':threatPct>30?'#f97316':'#22c55e'};">${threatPct}%</div>
                  <div class="vitals-stat-label">Threat</div>
                </div>
              </div>
              <div>
                <div style="font-size:0.56rem;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:3px;">HP Profile</div>
                ${hpBarHtml(hp)}
              </div>
            </div>`;
        });

        html += `</div>`;

        // ── Section: Battle Intensity ──
        html += `<div class="intel-widget">
          <div class="intel-section-title">⚔️ Battle Intensity</div>
          <div class="battle-intensity-gauge">
            <div class="intensity-label-row">
              <span>${iLabel}</span>
              <span class="intensity-label-val" style="color:${iColor};">${Math.round(intensity)}%</span>
            </div>
            <div class="intensity-bar-track">
              <div class="intensity-bar-fill" style="width:${intensity}%;background:linear-gradient(90deg,#22c55e ${100-intensity}%,${iColor} 100%);"></div>
            </div>
            <div style="font-size:0.58rem;color:var(--text-secondary);">Kills in last 10s: <strong style="color:#18181b;">${window.statsEngine.recentKillTimes.length}</strong></div>
          </div>
        </div>`;

        // ── Section: Food Dominance ──
        html += `<div class="intel-widget">
          <div class="intel-section-title">🌿 Food Dominance</div>
          <div style="display:flex;height:14px;border-radius:6px;overflow:hidden;gap:1px;">
            ${colonies.map(c=>{
              const hex='#'+c.exploreColor.getHexString();
              const pct = totalFood>0 ? (c.foodCollected/totalFood)*100 : (100/colonies.length);
              return `<div style="width:${pct}%;background:${hex};transition:width 0.5s ease;" title="${getColName(c.colonyId)}: ${c.foodCollected}"></div>`;
            }).join('')}
          </div>
          <div style="display:flex;justify-content:space-around;margin-top:7px;flex-wrap:wrap;gap:4px;">
            ${colonies.map(c=>{
              const hex='#'+c.exploreColor.getHexString();
              const pct = totalFood>0 ? (c.foodCollected/totalFood*100).toFixed(0) : Math.round(100/colonies.length);
              return `<div style="text-align:center;">
                ${colPillLight(c.colonyId, hex)}
                <div style="font-size:0.78rem;font-weight:900;color:${hex};margin-top:3px;">${pct}%</div>
                <div style="font-size:0.55rem;color:var(--text-secondary);">${c.foodCollected} units</div>
              </div>`;
            }).join('')}
          </div>
        </div>`;

        // ── Section: Mini Map ──
        html += `<div class="intel-widget">
          <div class="intel-section-title">🗺 Territory Map</div>
          <div class="mini-map-wrap">
            <canvas id="mini-map-canvas" width="258" height="120"></canvas>
          </div>
        </div>`;

        container.innerHTML = html;

        // Draw mini map
        renderMiniMap();
    }

    // ── COLONIES TAB ────────────────────────────────────────────
    if (activeIntelTab === 'colonies') {
        const container = document.getElementById('tab-colonies');
        if (!container) return;

        let html = '';

        colonies.forEach((c, ci) => {
            const hex = '#' + c.exploreColor.getHexString();
            const hist = window.statsEngine.histories[c.colonyId];
            const kd = (c.kdRatio||0).toFixed(2);
            const slope = c.populationSlope||0;
            const trendIcon = slope>0.2?'↑':slope<-0.2?'↓':'→';
            const trendColor = slope>0.2?'#22c55e':slope<-0.2?'#ef4444':'#71717a';
            const risk = c.extinctionRisk||0;
            const riskColor = risk>=70?'#ef4444':risk>=40?'#f97316':'#22c55e';
            const aggPct = Math.round((c.aggressionIndex||0)*100);
            const hp = c.hpBuckets||[0,0,0,10];
            const killsRow = window.statsEngine.killMatrix[c.colonyId]||{};
            const kills = Object.values(killsRow).reduce((a,b)=>a+b,0);
            const deaths = window.statsEngine.deathCounts[c.colonyId]||0;
            const threat = c.nearestThreatDist||9999;
            const threatPct = threat<9999?Math.round(Math.max(0,(1-threat/60))*100):0;

            html += `<div class="intel-widget colony-detail-block" style="border-left:3px solid ${hex};padding-left:9px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">
                <div style="display:flex; align-items:center; gap:6px;">
                  ${colPill(c.colonyId, hex)}
                  <span style="font-size:0.52rem; font-weight:800; background:rgba(0,0,0,0.05); color:var(--text-secondary); padding:1px 4px; border-radius:4px; display:inline-flex; align-items:center; gap:3px; text-transform:uppercase;">
                    <img class="tint-headshot-lazy" data-personality="${c.personality || 'dove'}" data-color="${hex}" style="width: 12px; height: 12px; object-fit: contain;" />
                    ${c.personality === 'grudger' ? 'Tit-for-Tat' : (c.personality || 'dove')}
                  </span>
                </div>
                <span style="font-size:0.65rem;font-weight:700;display:flex;align-items:center;gap:5px;">
                  <span style="color:${trendColor};">${trendIcon} ${slope>0?'+':''}${slope.toFixed(1)}/s</span>
                  <span style="color:${riskColor};background:rgba(0,0,0,0.04);padding:2px 6px;border-radius:6px;">Risk ${Math.round(risk)}%</span>
                </span>
              </div>`;

            // Sparkline
            html += `<div style="margin-bottom:6px;">${sparklineHtml(hist?hist.population:[], hex, c.colonyId)}</div>`;

            // Stats grid
            html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:7px;">
              <div class="vitals-stat-cell">
                <div class="vitals-stat-num" style="color:${hex};">${c.ants.length}</div>
                <div class="vitals-stat-label">Ants</div>
              </div>
              <div class="vitals-stat-cell">
                <div class="vitals-stat-num">${Math.round(c.meanHp||0)}</div>
                <div class="vitals-stat-label">Avg HP</div>
              </div>
              <div class="vitals-stat-cell">
                <div class="vitals-stat-num" style="color:${kills>deaths?'#22c55e':'#ef4444'};">${kd}</div>
                <div class="vitals-stat-label">K/D</div>
              </div>
              <div class="vitals-stat-cell">
                <div class="vitals-stat-num">${aggPct}%</div>
                <div class="vitals-stat-label">Combat</div>
              </div>
            </div>`;

            // Threat row
            html += `<div style="margin-bottom:7px;">
              <div style="display:flex;justify-content:space-between;font-size:0.58rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:3px;">
                <span>☢ Nearest Enemy</span>
                <span style="color:${threatPct>60?'#ef4444':threatPct>30?'#f97316':'#22c55e'};">${threat<9999?Math.round(threat)+'m away':'None detected'}</span>
              </div>
              <div class="threat-bar-row">
                <div class="threat-bar-track">
                  <div class="threat-bar-fill" style="width:${threatPct}%;background:${threatPct>60?'#ef4444':threatPct>30?'#f97316':'#22c55e'};"></div>
                </div>
              </div>
            </div>`;

            // HP bar
            html += `<div>
              <div style="font-size:0.56rem;font-weight:700;color:var(--text-secondary);text-transform:uppercase;margin-bottom:4px;">HP Distribution</div>
              ${hpBarHtml(hp)}
            </div>`;

            html += `</div>`;
        });

        container.innerHTML = html;
    }

    // ── COMBAT TAB ──────────────────────────────────────────────
    if (activeIntelTab === 'combat') {
        const container = document.getElementById('tab-combat');
        if (!container) return;

        let html = '';

        // ── Kill Attribution Matrix ──
        html += `<div class="intel-widget">
          <div class="intel-section-title">🎯 Kill Attribution Matrix
            <span style="font-size:0.6rem;font-weight:600;text-transform:none;color:var(--text-secondary);margin-left:auto;background:rgba(0,0,0,0.04);padding:2px 6px;border-radius:4px;">Row = Attacker ⚔️ Column = Victim</span>
          </div>
          <table class="km-table">
            <tr>
              <th class="km-attacker-label" style="font-size:0.52rem;color:var(--text-secondary);line-height:1.2;text-align:center;padding:4px;">
                Attacker <span style="font-weight:400;color:var(--text-tertiary);">(Row)</span><br>
                <span style="font-size:0.48rem;color:var(--text-tertiary);">vs</span><br>
                Victim <span style="font-weight:400;color:var(--text-tertiary);">(Col)</span>
              </th>`;
        colonies.forEach(c => {
            const hex = '#' + c.exploreColor.getHexString();
            html += `<th style="color:${hex};">${colPillCompact(c.colonyId, hex, true)}</th>`;
        });
        html += `</tr>`;

        colonies.forEach(attacker => {
            const aHex = '#' + attacker.exploreColor.getHexString();
            const ar = Math.round(attacker.exploreColor.r * 255);
            const ag = Math.round(attacker.exploreColor.g * 255);
            const ab = Math.round(attacker.exploreColor.b * 255);
            html += `<tr><th class="km-attacker-label">${colPillCompact(attacker.colonyId, aHex, true)}</th>`;
            colonies.forEach(victim => {
                if (attacker.colonyId === victim.colonyId) {
                    html += `<td class="km-diag">—</td>`;
                } else {
                    const row = window.statsEngine.killMatrix[attacker.colonyId]||{};
                    const kills = row[victim.colonyId]||0;
                    if (kills > 0) {
                        const alpha = Math.min(1.0, 0.3 + kills * 0.055);
                        const bg = `rgba(${ar},${ag},${ab},${alpha})`;
                        html += `<td style="background:${bg};color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.6);border:1px solid rgba(${ar},${ag},${ab},0.8);" title="${getColName(attacker.colonyId)} defeated ${kills}× ${getColName(victim.colonyId)}">${kills}</td>`;
                    } else {
                        html += `<td class="km-empty">·</td>`;
                    }
                }
            });
            html += `</tr>`;
        });
        html += `</table></div>`;

        // ── Diplomatic Stances Matrix ──
        html += `<div class="intel-widget" style="margin-top: 8px;">
          <div class="intel-section-title">🕊️ Diplomatic Stances Matrix
            <span style="font-size:0.6rem;font-weight:600;text-transform:none;color:var(--text-secondary);margin-left:auto;background:rgba(0,0,0,0.04);padding:2px 6px;border-radius:4px;">Row ➔ Column Stance</span>
          </div>
          <table class="km-table">
            <tr>
              <th class="km-attacker-label" style="font-size:0.52rem;color:var(--text-secondary);line-height:1.2;text-align:center;padding:4px;">
                Stance Owner <span style="font-weight:400;color:var(--text-tertiary);">(Row)</span><br>
                <span style="font-size:0.48rem;color:var(--text-tertiary);">towards</span><br>
                Target <span style="font-weight:400;color:var(--text-tertiary);">(Col)</span>
              </th>`;
        colonies.forEach(c => {
            const hex = '#' + c.exploreColor.getHexString();
            html += `<th style="color:${hex};">${colPillCompact(c.colonyId, hex, true)}</th>`;
        });
        html += `</tr>`;

        colonies.forEach(attacker => {
            const aHex = '#' + attacker.exploreColor.getHexString();
            html += `<tr><th class="km-attacker-label">${colPillCompact(attacker.colonyId, aHex, true)}</th>`;
            colonies.forEach(victim => {
                if (attacker.colonyId === victim.colonyId) {
                    html += `<td class="km-diag">—</td>`;
                } else {
                    const stance = attacker.stances[victim.colonyId] || 'Neutral';
                    let bg = 'rgba(0,0,0,0.03)';
                    let color = '#71717a';
                    let border = 'rgba(0,0,0,0.06)';
                    
                    if (stance === 'Allied') {
                        bg = 'rgba(34,197,94,0.12)';
                        color = '#22c55e';
                        border = 'rgba(34,197,94,0.3)';
                    } else if (stance === 'Hostile') {
                        bg = 'rgba(239,68,68,0.12)';
                        color = '#ef4444';
                        border = 'rgba(239,68,68,0.3)';
                    }
                    
                    html += `<td style="background:${bg};color:${color};border:1px solid ${border};font-size:0.58rem;font-weight:800;text-transform:uppercase;" title="${getColName(attacker.colonyId)} is ${stance} towards ${getColName(victim.colonyId)}">${stance.substring(0,3)}</td>`;
                }
            });
            html += `</tr>`;
        });
        html += `</table></div>`;



        // ── K/D Performance ──
        const sortedKD = [...colonies].sort((a,b)=>(b.kdRatio||0)-(a.kdRatio||0));
        html += `<div class="intel-widget">
          <div class="intel-section-title">📊 K/D Performance</div>`;

        sortedKD.forEach((c, idx) => {
            const hex = '#' + c.exploreColor.getHexString();
            const kd = c.kdRatio || 0;
            const killsRow = window.statsEngine.killMatrix[c.colonyId]||{};
            const kills = Object.values(killsRow).reduce((a,b)=>a+b,0);
            const deaths = window.statsEngine.deathCounts[c.colonyId]||0;
            const total = kills + deaths;
            const killPct = total>0 ? (kills/total)*100 : 50;
            const deathPct = total>0 ? (deaths/total)*100 : 50;
            const rankLabel = ['🥇','🥈','🥉',''][Math.min(idx,3)];

            let favTargetId=-1, maxKT=0, nemesisId=-1, maxDF=0;
            colonies.forEach(other => {
                if (other.colonyId !== c.colonyId) {
                    const k = killsRow[other.colonyId]||0;
                    if (k>maxKT){maxKT=k;favTargetId=other.colonyId;}
                    const otherRow = window.statsEngine.killMatrix[other.colonyId]||{};
                    const d = otherRow[c.colonyId]||0;
                    if (d>maxDF){maxDF=d;nemesisId=other.colonyId;}
                }
            });

            html += `<div class="kd-colony-row">
              <div class="kd-header-row">
                <div style="display:flex;align-items:center;gap:6px;">
                  <span style="font-size:1rem;">${rankLabel}</span>
                  ${colPill(c.colonyId, hex)}
                </div>
                <span style="font-size:0.68rem;font-weight:700;">
                  <span style="color:${hex};">${kills} kills</span> <span style="color:var(--text-secondary);">/</span> <span style="color:#ef4444;">${deaths} deaths</span>
                </span>
              </div>
              <div class="kd-dual-bar">
                <div class="kd-kills-fill" style="width:${killPct}%;background:${hex};"></div>
                <div class="kd-deaths-fill" style="width:${deathPct}%;"></div>
              </div>
              <div class="kd-meta">
                <span>Kill share: <strong>${killPct.toFixed(0)}%</strong></span>
                <span>K/D: <strong style="color:${kd>=1?'#22c55e':'#ef4444'};">${kd.toFixed(2)}</strong></span>
              </div>`;

            if (maxKT>0 || maxDF>0) {
                html += `<div class="kd-insight-row">`;
                if (maxKT>0) {
                    const tCol = colonies.find(col=>col.colonyId===favTargetId);
                    const tHex = tCol ? '#'+tCol.exploreColor.getHexString() : '#18181b';
                    html += `<div class="kd-insight-item">
                      <span style="color:var(--text-secondary);display:flex;align-items:center;gap:5px;">🎯 Hunts ${colPillLight(favTargetId,tHex)}</span>
                      <span style="font-weight:900;color:#18181b;">${maxKT}×</span>
                    </div>`;
                }
                if (maxDF>0) {
                    const nCol = colonies.find(col=>col.colonyId===nemesisId);
                    const nHex = nCol ? '#'+nCol.exploreColor.getHexString() : '#ef4444';
                    html += `<div class="kd-insight-item">
                      <span style="color:var(--text-secondary);display:flex;align-items:center;gap:5px;">💀 Hunted by ${colPillLight(nemesisId,nHex)}</span>
                      <span style="font-weight:900;color:#ef4444;">${maxDF}×</span>
                    </div>`;
                }
                html += `</div>`;
            } else {
                html += `<div style="font-size:0.6rem;color:var(--text-secondary);margin-top:4px;font-style:italic;">No engagements yet.</div>`;
            }
            html += `</div>`;
        });
        html += `</div>`;

        container.innerHTML = html;
    }

    // ── PREDICTIONS TAB ──────────────────────────────────────────
    if (activeIntelTab === 'predictions') {
        const container = document.getElementById('tab-predictions');
        if (!container) return;

        const iconBorderMap={'💀':'#ef4444','⚠️':'#f97316','⚔️':'#8b5cf6','🏆':'#22c55e','📈':'#3b82f6','🌿':'#10b981','🛡️':'#6366f1','🚨':'#ef4444','⏳':'#94a3b8'};
        const list = window.statsEngine.predictions||[];

        let html = '';
        if (list.length === 0) {
            html = `<div class="intel-widget" style="text-align:center;padding:24px 12px;">
              <div style="font-size:2rem;margin-bottom:8px;">🔭</div>
              <div style="font-size:0.72rem;color:var(--text-secondary);">Gathering statistics…<br>Check back after a few seconds.</div>
            </div>`;
        } else {
            list.forEach(p => {
                const bc = iconBorderMap[p.icon]||'#94a3b8';
                const bg = bc+'12';
                html += `<div class="pred-card" style="border-left-color:${bc};background:${bg};">
                  <div class="pred-icon">${p.icon}</div>
                  <div class="pred-body">
                    <div class="pred-title">${p.title}</div>
                    <div class="pred-desc">${p.desc}</div>
                  </div>
                </div>`;
            });
        }
        container.innerHTML = html;
    }

    // Trigger lazy tint loading for any headshots inside the intel panel
    const intelPanel = document.getElementById('intel-panel');
    if (intelPanel) {
        intelPanel.querySelectorAll('.tint-headshot-lazy').forEach(img => {
            const personality = img.getAttribute('data-personality');
            const color = img.getAttribute('data-color');
            getTintedHeadshot(personality, color, (dataUrl) => {
                img.src = dataUrl;
            });
        });
    }
}

// ── Mini Map Renderer (drawn on canvas) ─────────────────────
function renderMiniMap() {
    const canvas = document.getElementById('mini-map-canvas');
    if (!canvas || !colonies || colonies.length === 0) return;

    const W = canvas.width = canvas.offsetWidth || 258;
    const H = canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,W,H);

    // Background
    ctx.fillStyle = 'rgba(240,240,242,0.7)';
    ctx.fillRect(0,0,W,H);

    // World extents (nests + ants live within ~[-60,60])
    const WS = WORLD_SIZE * 0.6; // visible range = 72 units
    const toX = (wx) => ((wx + WS) / (WS*2)) * W;
    const toY = (wz) => ((wz + WS) / (WS*2)) * H;

    // Draw ants as tiny dots
    colonies.forEach(c => {
        const hex = '#' + c.exploreColor.getHexString();
        ctx.fillStyle = hex;
        c.ants.forEach(ant => {
            const px = toX(ant.x);
            const py = toY(ant.z);
            if (px>=0&&px<=W&&py>=0&&py<=H) {
                ctx.fillRect(px-0.7, py-0.7, 1.5, 1.5);
            }
        });
    });

    // Draw nests as larger circles with colony ring
    colonies.forEach(c => {
        const hex = '#' + c.exploreColor.getHexString();
        const nx = toX(c.nestX), ny = toY(c.nestZ);

        // Outer ring
        ctx.beginPath();
        ctx.arc(nx, ny, 5, 0, Math.PI*2);
        ctx.strokeStyle = hex;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Inner fill
        ctx.beginPath();
        ctx.arc(nx, ny, 3, 0, Math.PI*2);
        ctx.fillStyle = hex;
        ctx.fill();

        // Label
        ctx.font = 'bold 7px Space Grotesk, sans-serif';
        ctx.fillStyle = '#18181b';
        ctx.textAlign = 'center';
        const name = COLONY_NAMES[c.colonyId]||`C${c.colonyId}`;
        ctx.fillText(name.substring(0,3), nx, ny-7);
    });

    // Food sources (small red squares)
    sharedFoods.forEach(f => {
        if (!f || f.amount <= 0) return;
        const px=toX(f.x), py=toY(f.z);
        if (px>=0&&px<=W&&py>=0&&py<=H) {
            ctx.fillStyle = 'rgba(239,68,68,0.6)';
            ctx.fillRect(px-1.5,py-1.5,3,3);
        }
    });
}




function applyCameraPreset(preset) {
    cameraPresetMode = preset;
    
    document.querySelectorAll('.preset-option-btn').forEach(btn => {
        if (btn.getAttribute('data-preset') === preset) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    if (preset === 'default') {
        followAntMode = false;
        document.getElementById('btn-camera-orbit').classList.add('active');
        document.getElementById('btn-camera-follow').classList.remove('active');
        controls.enabled = true;
        controls.autoRotate = true;
        adjustCameraToFrameNests(false); // Glide smoothly to frame nests
    } else if (preset === 'battle') {
        followAntMode = false;
        isTransitioningCamera = false;
        document.getElementById('btn-camera-orbit').classList.add('active');
        document.getElementById('btn-camera-follow').classList.remove('active');
        controls.enabled = true;
        controls.autoRotate = true;
    } else if (preset === 'ant') {
        followAntMode = true;
        isTransitioningCamera = false;
        document.getElementById('btn-camera-follow').classList.add('active');
        document.getElementById('btn-camera-orbit').classList.remove('active');
        controls.enabled = false;
        controls.autoRotate = false;
        // Seed starting look target to match current controls to prevent coordinate snap jumps
        cameraLookTarget.copy(controls.target);
    }
}



function showNestStatsCard(index, clientX, clientY) {
    selectedNestIndex = index;
    const card = document.getElementById('nest-stats-card');
    if (card && clientX !== undefined && clientY !== undefined) {
        let x = clientX + 15;
        let y = clientY + 15;
        if (x + 270 > window.innerWidth) x = clientX - 280;
        if (y + 250 > window.innerHeight) y = clientY - 260;
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
        card.classList.remove('hidden');
    } else if (card) {
        card.classList.remove('hidden');
    }
    updateNestStatsCard();
}

function updateNestStatsCard() {
    if (selectedNestIndex === -1) return;
    const col = colonies[selectedNestIndex];
    if (!col) return;

    const getFriendlyColorName = (colId) => {
        if (COLONY_CONFIGS[colId]) {
            const match = COLONY_CONFIGS[colId].name.match(/\(([^)]+)\)/);
            if (match) return match[1];
            return COLONY_CONFIGS[colId].name;
        }
        return `Colony ${colId}`;
    };

    const colorDot = document.getElementById('nest-card-color-dot');
    const title = document.getElementById('nest-card-title');
    const risk = document.getElementById('nest-card-risk');
    const pop = document.getElementById('nest-card-pop');
    const food = document.getElementById('nest-card-food');
    const kd = document.getElementById('nest-card-kd');
    const barsContainer = document.getElementById('nest-card-bars-container');
    const hpBarContainer = document.getElementById('nest-card-hp-bar-container');

    const hex = '#' + col.exploreColor.getHexString();

    if (colorDot) colorDot.style.color = hex;
    if (title) title.innerText = getFriendlyColorName(col.colonyId) + ' Nest';
    
    // Risk status
    const riskVal = col.extinctionRisk || 0;
    if (risk) {
        risk.className = 'risk-badge';
        if (riskVal >= 70) {
            risk.classList.add('risk-high');
            risk.innerText = 'Critical!';
        } else if (riskVal >= 40) {
            risk.classList.add('risk-medium');
            risk.innerText = 'Vulnerable';
        } else {
            risk.classList.add('risk-low');
            risk.innerText = 'Stable';
        }
    }

    // Slope/trend details
    const slope = col.populationSlope || 0;
    const trendIcon = slope > 0.2 ? '↑' : slope < -0.2 ? '↓' : '→';
    const trendColor = slope > 0.2 ? '#22c55e' : slope < -0.2 ? '#ef4444' : '#71717a';
    if (pop) {
        pop.innerHTML = `${col.ants.length} <span style="font-size:0.6rem;color:${trendColor};font-weight:700;margin-left:4px;">${trendIcon} ${slope > 0 ? '+' : ''}${slope.toFixed(1)}/s</span>`;
    }

    // Food Dominance
    const totalFood = colonies.reduce((s, c) => s + c.foodCollected, 0);
    const foodPct = totalFood > 0 ? Math.round((col.foodCollected / totalFood) * 100) : Math.round(100 / colonies.length);
    if (food) {
        food.innerText = `${col.foodCollected} (${foodPct}%)`;
    }

    // K/D Ratio
    const killsRow = window.statsEngine.killMatrix[col.colonyId] || {};
    const kills = Object.values(killsRow).reduce((a, b) => a + b, 0);
    const deaths = window.statsEngine.deathCounts[col.colonyId] || 0;
    const ratio = col.kdRatio || 0;
    if (kd) {
        kd.innerText = `${kills} K / ${deaths} D (${ratio.toFixed(1)})`;
    }

    // Render Bars
    const aggPct = Math.round((col.aggressionIndex || 0) * 100);
    const hpBuckets = col.hpBuckets || [0, 0, 0, 10];
    const tot = hpBuckets.reduce((a, b) => a + b, 0) || 1;
    const healthScore = Math.round(((hpBuckets[2] + hpBuckets[3]) / tot) * 100);
    const threat = col.nearestThreatDist || 9999;
    const threatPct = threat < 9999 ? Math.round(Math.max(0, (1 - threat / 60)) * 100) : 0;

    const createMiniBarLocal = (pct, color, label) => {
        const p = Math.max(0, Math.min(100, pct));
        return `<div class="intel-mini-bar-row">
          <span class="intel-mini-bar-label" style="font-size:0.6rem; min-width:54px;">${label}</span>
          <div class="intel-mini-bar-track" style="height:4px;"><div class="intel-mini-bar-fill" style="width:${p}%;background:${color};"></div></div>
          <span class="intel-mini-bar-pct" style="font-size:0.6rem; min-width:24px;">${Math.round(p)}%</span>
        </div>`;
    };

    if (barsContainer) {
        barsContainer.innerHTML = 
            createMiniBarLocal(aggPct, '#ef4444', '⚔ Combat') +
            createMiniBarLocal(healthScore, '#22c55e', '❤ Health') +
            createMiniBarLocal(threatPct, '#f97316', '☢ Threat');
    }

    if (hpBarContainer) {
        const p = hpBuckets.map(b => (b / tot * 100).toFixed(1));
        hpBarContainer.innerHTML = `<div class="hp-dist-bar" style="height:7px;border-radius:4px;display:flex;overflow:hidden;background:rgba(24,24,27,0.05);cursor:help;" title="HP Profile: Hover over individual labels below for detailed health ranges.">
          <div class="hp-dist-seg hp-seg-low" style="width:${p[0]}%;background:#ef4444;height:100%;"></div>
          <div class="hp-dist-seg hp-seg-med-low" style="width:${p[1]}%;background:#f97316;height:100%;"></div>
          <div class="hp-dist-seg hp-seg-med-high" style="width:${p[2]}%;background:#eab308;height:100%;"></div>
          <div class="hp-dist-seg hp-seg-high" style="width:${p[3]}%;background:#22c55e;height:100%;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.58rem;font-weight:700;margin-top:5px;flex-wrap:wrap;gap:2px;">
          <span style="color:#ef4444;display:inline-flex;align-items:center;cursor:help;" title="Critical: 0% - 25% HP (Near death/sustained fatal damage)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ef4444;margin-right:3px;"></span>Crit: ${Math.round(p[0])}%</span>
          <span style="color:#f97316;display:inline-flex;align-items:center;cursor:help;" title="Low: 26% - 50% HP (Taken major battle damage)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#f97316;margin-right:3px;"></span>Low: ${Math.round(p[1])}%</span>
          <span style="color:#eab308;display:inline-flex;align-items:center;cursor:help;" title="Mid: 51% - 75% HP (Taken minor combat damage)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#eab308;margin-right:3px;"></span>Mid: ${Math.round(p[2])}%</span>
          <span style="color:#22c55e;display:inline-flex;align-items:center;cursor:help;" title="Full: 76% - 100% HP (Uninjured foragers or fresh spawns)"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#22c55e;margin-right:3px;"></span>Full: ${Math.round(p[3])}%</span>
        </div>`;
    }
}

// Initialize the app
window.onload = init;
