/**
 * Main Application Orchestrator
 */

import { getTerrainHeight, createTerrainMesh, randomizeTerrainSeed, setNestPositionsForTerrain } from './terrain.js';
import { PheromoneGrid } from './pheromones.js';
import { ColonyManager } from './colony.js';

// Simulation Constants
const WORLD_SIZE = 120;
const INITIAL_ANTS = 250;
const PHEROMONE_RES = 256;

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
function adjustCameraToFrameNests() {
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
    
    camera.position.set(center.x, center.y + camHeight, center.z + camDepth);
    
    // Update OrbitControls targets
    controls.target.copy(center);
    cameraLookTarget.copy(center);
    camera.lookAt(center);
    
    controls.update();
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
        maxAge: 2.2, // Rises for 2.2 seconds before dissolving
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
            
            const label = document.createElement('span');
            label.id = `defeated-text-${i}`;
            label.className = 'bar-label';
            label.innerText = '0';
            
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
}

function rebuildSimulation() {
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
        
        colonies.push(colManager);
    }
    
    // 5. Spawn shared elements
    initialTotalFood = spawnDefaultFood();
    spawnObstacles(40);
    
    // 6. UI elements
    rebuildScoreboardAndLegend();
    
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
    
    const coreGeom = new THREE.SphereGeometry(1.8, 16, 16);
    const coreMat = new THREE.MeshStandardMaterial({
        color: 0x000000, // Black diffuse to ignore scene lighting
        emissive: coreColor, // Self-illuminated emissive color matching the colony color
        emissiveIntensity: 2.5, // Bright glowing intensity
        roughness: 0.15,
        metalness: 0.1
    });
    const core = new THREE.Mesh(coreGeom, coreMat);
    core.position.y = 0.9;
    core.castShadow = true;
    core.receiveShadow = true;
    nestGroup.add(core);
    
    const domeGeom = new THREE.SphereGeometry(2.6, 32, 32); // Smooth sphere geometry, slightly tighter 2.6 radius
    const domeMat = new THREE.MeshPhysicalMaterial({
        color: 0x000000, // Black diffuse color to ignore scene lighting
        emissive: coreColor, // Emissive color matching the nest core (self-lit)
        emissiveIntensity: 2.2, // Boosted glow intensity
        roughness: 0.2,
        metalness: 0.1,
        transmission: 0,
        transparent: true,
        opacity: 0.4, // Subtle, soft transparent glow
        depthWrite: false
    });
    const dome = new THREE.Mesh(domeGeom, domeMat);
    dome.position.y = 0.9;
    nestGroup.add(dome);
    
    const nestLight = new THREE.PointLight(coreColor, 3.0, 15);
    nestLight.position.y = 1.5;
    nestGroup.add(nestLight);
    
    nestGroup.position.set(x, yPos, z);
    scene.add(nestGroup);
    
    return nestGroup;
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
        const now = Date.now();
        if (now - lastDefeatSoundTime < 450) return;
        lastDefeatSoundTime = now;
        
        try {
            initAudio();
            if (!audioCtx) return;
            const osc = audioCtx.createOscillator();
            const filter = audioCtx.createBiquadFilter();
            const gain = audioCtx.createGain();
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(80, audioCtx.currentTime);
            osc.frequency.linearRampToValueAtTime(40, audioCtx.currentTime + 0.25);
            
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(100, audioCtx.currentTime);
            filter.frequency.linearRampToValueAtTime(50, audioCtx.currentTime + 0.25);
            
            gain.gain.setValueAtTime(0.0, audioCtx.currentTime);
            gain.gain.linearRampToValueAtTime(0.22, audioCtx.currentTime + 0.04); 
            gain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.25);
            
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(audioCtx.destination);
            
            osc.start();
            osc.stop(audioCtx.currentTime + 0.26);
        } catch(e) {}
    };

    window.playKickSound = () => {
        try {
            initAudio();
            if (!audioCtx) return;
            const osc = audioCtx.createOscillator();
            const filter = audioCtx.createBiquadFilter();
            const gain = audioCtx.createGain();
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(120, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.1);
            
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(150, audioCtx.currentTime);
            
            // Soft envelope: 10ms attack, 90ms decay for a subtle thuddy kick
            gain.gain.setValueAtTime(0.0, audioCtx.currentTime);
            gain.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + 0.01);
            gain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.1);
            
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(audioCtx.destination);
            
            osc.start();
            osc.stop(audioCtx.currentTime + 0.11);
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
    
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('pointerdown', onCanvasClick);
    
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

    const btnCamera = document.getElementById('btn-camera-preset');
    const cameraMenu = document.getElementById('camera-preset-menu');
    const btnSettings = document.getElementById('btn-settings-toggle');
    const dashboard = document.querySelector('.dashboard');
    const btnColonyPill = document.getElementById('btn-colony-pill');
    const panelColonyEdit = document.getElementById('panel-colony-edit');
    const btnAntPill = document.getElementById('btn-ant-pill');
    const panelAntEdit = document.getElementById('panel-ant-edit');
    
    btnCamera.addEventListener('click', (e) => {
        e.stopPropagation();
        cameraMenu.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
    });
    
    btnSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        dashboard.classList.toggle('hidden');
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
    });

    btnColonyPill.addEventListener('click', (e) => {
        e.stopPropagation();
        panelColonyEdit.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        cameraMenu.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
    });

    btnAntPill.addEventListener('click', (e) => {
        e.stopPropagation();
        panelAntEdit.classList.toggle('hidden');
        dashboard.classList.add('hidden');
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
    });

    panelColonyEdit.addEventListener('click', (e) => e.stopPropagation());
    panelAntEdit.addEventListener('click', (e) => e.stopPropagation());
    
    window.addEventListener('click', () => {
        cameraMenu.classList.add('hidden');
        panelColonyEdit.classList.add('hidden');
        panelAntEdit.classList.add('hidden');
    });
    
    document.querySelectorAll('.preset-option-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const preset = btn.getAttribute('data-preset');
            applyCameraPreset(preset);
            cameraMenu.classList.add('hidden');
        });
    });
};


// Raycast to place food sources on terrain click
function onCanvasClick(event) {
    if (!isPlacingFood) return;
    
    // Calculate normalized mouse coordinates (-1 to 1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
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
        }
    }
    
    // Update combat visual feedback particles
    if (combatParticles) {
        combatParticles.update(dt);
    }
    
    // 2. Nest Animations (rotate outer wireframe dome, pulse point lights for all nests)
    nests.forEach((nest) => {
        nest.children[1].rotation.y += dt * 0.2;
        nest.children[1].rotation.x += dt * 0.1;
        nest.children[2].intensity = 3.0 + Math.sin(time * 0.003) * 1.5;
    });
    
    // 3. Camera Controls / Tracking Update
    if (cameraPresetMode === 'ant' && colonies[0] && colonies[0].ants.length > 0) {
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
    const colonyDefeated = [];
    let totalDefeated = 0;
    
    for (let i = 0; i < activeColonyCount; i++) {
        const collected = colonies[i] ? colonies[i].foodCollected : 0;
        const defeated = colonies[i] ? colonies[i].antsDefeated : 0;
        colonyFood.push(collected);
        colonyDefeated.push(defeated);
        totalCollected += collected;
        totalDefeated += defeated;
    }
    
    // Defeated segments update
    for (let i = 0; i < activeColonyCount; i++) {
        let defPct = 100 / activeColonyCount;
        if (totalDefeated > 0) {
            defPct = (colonyDefeated[i] / totalDefeated) * 100;
        }
        const barSeg = document.getElementById(`bar-defeated-${i}`);
        const labelText = document.getElementById(`defeated-text-${i}`);
        if (barSeg && labelText) {
            barSeg.style.width = defPct + '%';
            labelText.innerText = defPct > 6 ? colonyDefeated[i] : "";
        }
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
        adjustCameraToFrameNests();
    } else if (preset === 'battle') {
        followAntMode = false;
        document.getElementById('btn-camera-orbit').classList.add('active');
        document.getElementById('btn-camera-follow').classList.remove('active');
        controls.enabled = true;
        controls.autoRotate = true;
    } else if (preset === 'ant') {
        followAntMode = true;
        document.getElementById('btn-camera-follow').classList.add('active');
        document.getElementById('btn-camera-orbit').classList.remove('active');
        controls.enabled = false;
        controls.autoRotate = false;
    }
}

// Initialize the app
window.onload = init;
