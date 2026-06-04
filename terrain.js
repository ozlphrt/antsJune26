/**
 * 3D Terrain Generator for Ant Colony Simulation
 */

// Offsets to randomize terrain generation
let terrainOffsetX = 0;
let terrainOffsetZ = 0;
let nestPositions = [];

// Precomputed height cache variables
let heightGrid = null;
const minCoord = -80;
const maxCoord = 80;
const res = 0.2;
const invRes = 1 / res;
const gridSize = Math.ceil((maxCoord - minCoord) * invRes) + 1;

export function randomizeTerrainSeed() {
    terrainOffsetX = Math.random() * 10000 - 5000;
    terrainOffsetZ = Math.random() * 10000 - 5000;
    heightGrid = null; // Invalidate cache
}

export function setNestPositionsForTerrain(positions) {
    nestPositions = positions;
    heightGrid = null; // Invalidate cache
}

// Compute natural height without cache
function computeTerrainHeightRaw(x, z) {
    const rx = x + terrainOffsetX;
    const rz = z + terrainOffsetZ;

    // large-scale terrain features (hills and valleys)
    let h1 = Math.sin(rx * 0.02) * Math.cos(rz * 0.02) * 8.0;
    
    // medium-scale bumps
    let h2 = Math.sin(rx * 0.07 + 2.0) * Math.cos(rz * 0.06 - 1.0) * 2.5;
    
    // small-scale details
    let h3 = Math.sin(rx * 0.2) * Math.cos(rz * 0.18) * 0.6;
    
    // Combine octaves
    let height = h1 + h2 + h3;
    
    // Dynamically flatten terrain around each nest location
    for (let i = 0; i < nestPositions.length; i++) {
        const nest = nestPositions[i];
        const dx = x - nest.x;
        const dz = z - nest.z;
        const distSq = dx*dx + dz*dz;
        const nestFlattenRadius = 6.0;
        const nestFlattenRadiusSq = nestFlattenRadius * nestFlattenRadius;
        
        if (distSq < nestFlattenRadiusSq) {
            const dist = Math.sqrt(distSq);
            // Compute natural unflattened height at the nest center
            const nrx = nest.x + terrainOffsetX;
            const nrz = nest.z + terrainOffsetZ;
            const nh1 = Math.sin(nrx * 0.02) * Math.cos(nrz * 0.02) * 8.0;
            const nh2 = Math.sin(nrx * 0.07 + 2.0) * Math.cos(nrz * 0.06 - 1.0) * 2.5;
            const nh3 = Math.sin(nrx * 0.2) * Math.cos(nrz * 0.18) * 0.6;
            const nestNaturalHeight = nh1 + nh2 + nh3;
            
            const t = dist / nestFlattenRadius;
            const smoothFactor = t * t * (3 - 2 * t);
            height = nestNaturalHeight * (1.0 - smoothFactor) + height * smoothFactor;
        }
    }
    
    return height;
}

// Precomputes the height grid
export function precomputeHeightGrid() {
    heightGrid = new Float32Array(gridSize * gridSize);
    for (let gz = 0; gz < gridSize; gz++) {
        const z = minCoord + gz * res;
        for (let gx = 0; gx < gridSize; gx++) {
            const x = minCoord + gx * res;
            heightGrid[gz * gridSize + gx] = computeTerrainHeightRaw(x, z);
        }
    }
}

// Fast mathematical height function for the terrain using bilinear interpolation
export function getTerrainHeight(x, z) {
    if (!heightGrid) {
        precomputeHeightGrid();
    }
    
    const gx = (x - minCoord) * invRes;
    const gz = (z - minCoord) * invRes;
    
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    
    if (ix < 0 || ix >= gridSize - 1 || iz < 0 || iz >= gridSize - 1) {
        return computeTerrainHeightRaw(x, z);
    }
    
    const fx = gx - ix;
    const fz = gz - iz;
    
    const idx = iz * gridSize + ix;
    const h00 = heightGrid[idx];
    const h10 = heightGrid[idx + 1];
    const h01 = heightGrid[idx + gridSize];
    const h11 = heightGrid[idx + gridSize + 1];
    
    return h00 * (1 - fx) * (1 - fz) +
           h10 * fx * (1 - fz) +
           h01 * (1 - fx) * fz +
           h11 * fx * fz;
}

/**
 * Creates the terrain mesh with vertex coloring based on height and slope
 */
export function createTerrainMesh(width, depth, segments) {
    // Precompute height grid now that seed and nests are set
    precomputeHeightGrid();

    const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
    
    // Rotate geometry to make it horizontal (parallel to X-Z plane)
    geometry.rotateX(-Math.PI / 2);
    
    const position = geometry.attributes.position;
    const colors = [];
    
    // Color definitions (Light slate grey palette)
    const colorLow = new THREE.Color(0xdddddf);     // Valleys
    const colorMid = new THREE.Color(0xe5e5e7);     // Plains
    const colorHigh = new THREE.Color(0xf0f0f2);    // Peaks
    const colorSlope = new THREE.Color(0xd2d2d5);   // Slopes
    
    for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const z = position.getZ(i);
        
        // Calculate height and set Y value
        const y = getTerrainHeight(x, z);
        position.setY(i, y);
        
        // Dynamic Vertex Coloring based on height and local slope
        let finalColor = new THREE.Color();
        
        // Normalize height between approx -10 and 10
        const normH = (y + 10) / 20;
        const clampedH = Math.max(0, Math.min(1, normH));
        
        if (clampedH < 0.4) {
            // Valleys
            finalColor.copy(colorLow).lerp(colorMid, clampedH / 0.4);
        } else {
            // Peaks
            finalColor.copy(colorMid).lerp(colorHigh, (clampedH - 0.4) / 0.6);
        }
        
        // Adjust coloring for steepness/slope
        // Estimate slope using nearby values
        const delta = 0.5;
        const hL = getTerrainHeight(x - delta, z);
        const hR = getTerrainHeight(x + delta, z);
        const hD = getTerrainHeight(x, z - delta);
        const hU = getTerrainHeight(x, z + delta);
        
        const normal = new THREE.Vector3(hL - hR, 2 * delta, hD - hU).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const slope = 1.0 - normal.dot(up); // 0 at flat, 1 at vertical wall
        
        if (slope > 0.15) {
            finalColor.lerp(colorSlope, Math.min(0.7, (slope - 0.15) * 2));
        }
        
        colors.push(finalColor.r, finalColor.g, finalColor.b);
    }
    
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    // Recalculate normals for correct lighting
    geometry.computeVertexNormals();
    
    // Modern premium material: Rough surface with subtle reflection, using vertex colors
    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.1,
        flatShading: true // Gives a stylized digital low-poly look
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = true;

    // High-tech overlay grid
    const wireMaterial = new THREE.MeshBasicMaterial({
        color: 0x8c8c9a,
        wireframe: true,
        transparent: true,
        opacity: 0.08
    });
    const wireMesh = new THREE.Mesh(geometry, wireMaterial);
    wireMesh.position.y = 0.02; // Tiny offset to prevent Z-fighting
    mesh.add(wireMesh);
    
    return mesh;
}
