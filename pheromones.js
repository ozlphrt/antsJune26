/**
 * Pheromone Field Grid & Dynamics
 */

export class PheromoneGrid {
    constructor(worldSize, resolution, homeRGB = [239, 68, 68], foodRGB = [16, 185, 129]) {
        this.worldSize = worldSize; // e.g. 100 units
        this.resolution = resolution; // e.g. 100 cells (1 cell = 1 unit)
        this.homeRGB = homeRGB;
        this.foodRGB = foodRGB;
        
        const size = this.resolution * this.resolution;
        this.homeGrid = new Float32Array(size);
        this.foodGrid = new Float32Array(size);
        this.tempHome = new Float32Array(size);
        this.tempFood = new Float32Array(size);
        
        // Canvas for texture rendering
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.resolution;
        this.canvas.height = this.resolution;
        this.ctx = this.canvas.getContext('2d');
        
        // Create Canvas Texture
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        
        this.decayRate = 0.995; // Configurable decay per frame
    }
    
    // Convert world X/Z to grid index
    worldToGrid(x, z) {
        // Map from [-worldSize/2, worldSize/2] to [0, resolution - 1]
        const col = Math.floor(((x + this.worldSize / 2) / this.worldSize) * this.resolution);
        const row = Math.floor(((z + this.worldSize / 2) / this.worldSize) * this.resolution);
        
        if (col >= 0 && col < this.resolution && row >= 0 && row < this.resolution) {
            return row * this.resolution + col;
        }
        return -1;
    }
    
    // Deposit pheromone intensity at world coordinate
    deposit(x, z, type, amount) {
        const idx = this.worldToGrid(x, z);
        if (idx !== -1) {
            if (type === 'home') {
                this.homeGrid[idx] = Math.min(5.0, this.homeGrid[idx] + amount);
            } else if (type === 'food') {
                this.foodGrid[idx] = Math.min(5.0, this.foodGrid[idx] + amount);
            }
        }
    }
    
    // Query pheromone level at world coordinate
    getPheromone(x, z, type) {
        const idx = this.worldToGrid(x, z);
        if (idx !== -1) {
            return type === 'home' ? this.homeGrid[idx] : this.foodGrid[idx];
        }
        return 0;
    }
    
    // Evaporate and Diffuse trails
    update() {
        const res = this.resolution;
        
        // 1. Evaporation Pass (diffusion disabled to keep trails razor-thin)
        for (let r = 0; r < res; r++) {
            for (let c = 0; c < res; c++) {
                const idx = r * res + c;
                
                // Evaporate values directly
                this.tempHome[idx] = this.homeGrid[idx] * this.decayRate;
                this.tempFood[idx] = this.foodGrid[idx] * this.decayRate;
                
                // Cutoff extremely small values to save computing/visual noise
                if (this.tempHome[idx] < 0.01) this.tempHome[idx] = 0;
                if (this.tempFood[idx] < 0.01) this.tempFood[idx] = 0;
            }
        }
        
        // Swap arrays
        const swapHome = this.homeGrid;
        this.homeGrid = this.tempHome;
        this.tempHome = swapHome;
        
        const swapFood = this.foodGrid;
        this.foodGrid = this.tempFood;
        this.tempFood = swapFood;
        
        // 2. Draw Grid data onto Offscreen Canvas
        const imgData = this.ctx.createImageData(res, res);
        const data = imgData.data;
        
        for (let i = 0; i < res * res; i++) {
            let h = 0;
            const hVal = this.homeGrid[i];
            if (hVal >= 3.0) h = 1.0;      // Dark/high frequency
            else if (hVal >= 1.0) h = 0.60; // Mid frequency
            else if (hVal >= 0.05) h = 0.25; // Light/low frequency

            let f = 0;
            const fVal = this.foodGrid[i];
            if (fVal >= 3.0) f = 1.0;      // Dark/high frequency
            else if (fVal >= 1.0) f = 0.60; // Mid frequency
            else if (fVal >= 0.05) f = 0.25; // Light/low frequency
            
            const pxIdx = i * 4;
            
            // Blend home and food colors based on respective dynamic RGB sets
            data[pxIdx]     = Math.floor(h * this.homeRGB[0] + f * this.foodRGB[0]);    // R
            data[pxIdx + 1] = Math.floor(h * this.homeRGB[1] + f * this.foodRGB[1]);    // G
            data[pxIdx + 2] = Math.floor(h * this.homeRGB[2] + f * this.foodRGB[2]);    // B
            data[pxIdx + 3] = Math.floor(Math.max(h, f) * 230); // Alpha intensity
        }
        
        this.ctx.putImageData(imgData, 0, 0);
        this.texture.needsUpdate = true;
    }
    
    // Clear all pheromones
    reset() {
        this.homeGrid.fill(0);
        this.foodGrid.fill(0);
        this.update();
    }
}
