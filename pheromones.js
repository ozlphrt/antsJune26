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
        
        // Secondary offscreen canvas to apply hardware-accelerated blur filtering
        this.tempCanvas = document.createElement('canvas');
        this.tempCanvas.width = this.resolution;
        this.tempCanvas.height = this.resolution;
        this.tempCtx = this.tempCanvas.getContext('2d');
        
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
            if (hVal >= 0.05) {
                const level = Math.min(32, Math.ceil(hVal * 8.0)); // Map 0.05..4.0+ to 1..32 steps
                h = 0.35 + (level / 32.0) * 0.65; // 32 discrete tones starting at 0.37 opacity floor
            }

            let f = 0;
            const fVal = this.foodGrid[i];
            if (fVal >= 0.05) {
                const level = Math.min(32, Math.ceil(fVal * 8.0)); // Map 0.05..4.0+ to 1..32 steps
                f = 0.35 + (level / 32.0) * 0.65; // 32 discrete tones starting at 0.37 opacity floor
            }
            
            const pxIdx = i * 4;
            const maxVal = Math.max(h, f);
            
            // Render full-brightness color to keep it visible, only modifying alpha for intensity tiers
            const r = h > f ? this.homeRGB[0] : this.foodRGB[0];
            const g = h > f ? this.homeRGB[1] : this.foodRGB[1];
            const b = h > f ? this.homeRGB[2] : this.foodRGB[2];
            
            data[pxIdx]     = r;
            data[pxIdx + 1] = g;
            data[pxIdx + 2] = b;
            data[pxIdx + 3] = Math.floor(maxVal * 255); // Alpha intensity maps to 0.25, 0.60, 1.0
        }
        
        this.tempCtx.putImageData(imgData, 0, 0);
        
        // Clear main canvas and draw blurred version
        this.ctx.clearRect(0, 0, res, res);
        this.ctx.filter = 'blur(0.7px)'; // Mild blur: takes the jagged edge off while keeping trails sharp
        this.ctx.drawImage(this.tempCanvas, 0, 0);
        
        this.texture.needsUpdate = true;
    }
    
    // Clear all pheromones
    reset() {
        this.homeGrid.fill(0);
        this.foodGrid.fill(0);
        this.update();
    }
}
