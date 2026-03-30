/**
 * Created on Wed 04 Feb 2026 03∶18∶10 PM
 * Author: Shubham Jariwala
 * 3D-IntelliScan Frontend Logic
 * Handles file uploads, processing triggers, and status polling.
 */

// Global state
const pollIntervals = { left: null, right: null };
const currentSamples = { left: { id: null, tag: null }, right: { id: null, tag: null } };
const detectionCache = {}; // Stores detection data per sample
const detectionState = { left: { view: 'view1', slice: 0 }, right: { view: 'view1', slice: 0 } };

// Inject CSS for bump markers
const markerStyleId = 'bump-marker-styles';
if (!document.getElementById(markerStyleId)) {
    const style = document.createElement('style');
    style.id = markerStyleId;
    style.innerHTML = `
        @keyframes pulse-ring {
            0% { transform: scale(0.33); opacity: 1; }
            80%, 100% { transform: scale(2.0); opacity: 0; }
        }
        @keyframes pulse-dot {
            0% { transform: translate(-50%, -50%) scale(0.8); }
            50% { transform: translate(-50%, -50%) scale(1.2); }
            100% { transform: translate(-50%, -50%) scale(0.8); }
        }
        @keyframes bounce-arrow {
            0%, 100% { transform: translateX(-50%) translateY(0); }
            50% { transform: translateX(-50%) translateY(-15px); }
        }
        .bump-marker-container {
            position: relative;
            width: 40px;
            height: 40px;
            transform: translate(-50%, -50%);
            pointer-events: none;
        }
        .bump-ring {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            border: 2px solid #ffff00;
            border-radius: 50%;
            animation: pulse-ring 1.5s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
            box-shadow: 0 0 8px #ffff00;
            background-color: rgba(255, 255, 0, 0.3);
        }
        .bump-dot {
            position: absolute;
            top: 50%; left: 50%;
            width: 8px; height: 8px;
            background: #ffff00;
            border-radius: 50%;
            transform: translate(-50%, -50%);
            animation: pulse-dot 1.5s cubic-bezier(0.455, 0.03, 0.515, 0.955) -0.4s infinite;
        }
        .bump-arrow-static {
            position: absolute;
            top: -35px;
            left: 50%;
            transform: translateX(-50%);
            color: #ffff00;
            font-size: 24px;
            font-weight: bold;
            text-shadow: 0 0 4px #000;
            animation: bounce-arrow 1s ease-in-out infinite;
        }
    `;
    document.head.appendChild(style);
}

/**
 * Handle the upload button click.
 * 1. Uploads the file to /api/upload
 * 2. Triggers processing at /api/process
 * 3. Starts polling /api/jobs
 */
async function handleUpload(side) {
    const fileInput = document.getElementById(`${side}-fileInput`);
    const uploadBtn = document.getElementById(`${side}-uploadBtn`);
    const statusDiv = document.getElementById(`${side}-statusMessage`);
    const resultsSection = document.getElementById(`${side}-resultsSection`);
    const pipelinePhases = document.getElementById(`${side}-pipelinePhases`);

    // Reset UI
    if (resultsSection) resultsSection.style.display = 'none';
    if (pipelinePhases) {
        pipelinePhases.style.display = 'none';
        // Reset cards content and style
        pipelinePhases.querySelectorAll('.phase-card').forEach(card => {
            const badge = card.querySelector('.status-badge');
            if(badge) {
                badge.className = 'badge bg-secondary status-badge';
                badge.innerText = 'Pending';
            }
            card.style.borderLeft = 'none';
            const content = card.querySelector('.phase-content');
            if(content) content.innerHTML = '';
        });
    }
    
    // Validation
    if (!fileInput || !fileInput.files.length) {
        alert("Please select a NIfTI file (.nii or .nii.gz) first.");
        return;
    }

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append("file", file);

    try {
        // Update UI state
        if (uploadBtn) uploadBtn.disabled = true;
        if (statusDiv) {
            statusDiv.innerText = "Uploading file...";
            statusDiv.className = "mt-4 text-center fw-medium text-primary";
        }

        // 1. Upload File
        const uploadResponse = await fetch("/api/upload", {
            method: "POST",
            body: formData
        });

        if (!uploadResponse.ok) {
            const errorData = await uploadResponse.json();
            throw new Error(errorData.detail || "Upload failed");
        }

        const uploadData = await uploadResponse.json();
        const { sample_id, filename, path } = uploadData;
        
        console.log("Upload complete:", uploadData);
        if (statusDiv) statusDiv.innerText = `Upload complete. Starting analysis for ${sample_id}...`;

        // 2. Trigger Processing
        const processResponse = await fetch(`/api/process/${sample_id}/${filename}?force=true`, {
            method: "POST"
        });

        if (!processResponse.ok) {
            const errorData = await processResponse.json();
            throw new Error(errorData.detail || "Processing start failed");
        }

        const processData = await processResponse.json();
        
        if (processData.status === "started" || processData.status === "skipped") {
            if (statusDiv) statusDiv.innerText = "Processing started. Please wait...";
            
            // Show phases
            if (pipelinePhases) pipelinePhases.style.display = 'block';
            
            // Start polling
            startPolling(side, path, sample_id);
        } else {
            throw new Error(`Unexpected status: ${processData.status}`);
        }

    } catch (error) {
        console.error("Error:", error);
        if (statusDiv) {
            statusDiv.innerText = `Error: ${error.message}`;
            statusDiv.className = "mt-4 text-center fw-bold text-danger";
        }
        if (uploadBtn) uploadBtn.disabled = false;
    }
}

/**
 * Load an existing sample from the dropdown.
 */
window.loadSample = async function(side) {
    const select = document.getElementById(`${side}-sampleSelect`);
    const modelSelect = document.getElementById(`${side}-modelSelect`);
    const option = select.options[select.selectedIndex];
    const sampleId = select.value;
    const tag = modelSelect.value;
    
    if (!sampleId) {
        alert("Please select a sample first.");
        return;
    }

    const filename = option.dataset.filename;
    
    // Reset UI to clear previous sample data
    const resultsSection = document.getElementById(`${side}-resultsSection`);
    if (resultsSection) resultsSection.style.display = 'none';

    const pipelinePhases = document.getElementById(`${side}-pipelinePhases`);
    if (pipelinePhases) {
        pipelinePhases.querySelectorAll('.phase-card').forEach(card => {
            const badge = card.querySelector('.status-badge');
            if(badge) {
                badge.className = 'badge bg-secondary status-badge';
                badge.innerText = 'Pending';
            }
            card.style.borderLeft = 'none';
            const content = card.querySelector('.phase-content');
            if(content) content.innerHTML = '';
        });
        pipelinePhases.style.display = 'block';
    }
    
    // Trigger processing if a filename is available (for re-running)
    if (filename) {
        const statusDiv = document.getElementById(`${side}-statusMessage`);
        if (statusDiv) {
            statusDiv.innerText = "Starting analysis for existing sample...";
            statusDiv.className = "mt-4 text-center fw-medium text-primary";
        }
        try {
            await fetch(`/api/process/${sampleId}/${filename}?force=false&tag=${tag || ''}`, { method: "POST" });
        } catch (e) {
            console.error("Error triggering process:", e);
        }
    }
    
    // Start polling immediately for the existing sample
    startPolling(side, null, sampleId, tag);
}

/**
 * Poll the backend for job status.
 */
function startPolling(side, inputPath, sampleId, tag) {
    currentSamples[side] = { id: sampleId, tag: tag };
    const statusDiv = document.getElementById(`${side}-statusMessage`);
    const uploadBtn = document.getElementById(`${side}-uploadBtn`);
    
    if (pollIntervals[side]) clearInterval(pollIntervals[side]);

    pollIntervals[side] = setInterval(async () => {
        try {
            // Poll the granular status endpoint
            const response = await fetch(`/api/status/${sampleId}?tag=${tag || ''}`);
            const status = await response.json();
            
            const effectiveId = status.output_id || sampleId;

            updatePhaseUI(side, 'conversion', status.conversion, status.data, sampleId, status.durations?.conversion, tag);
            updatePhaseUI(side, 'detection', status.detection, status.data, sampleId, status.durations?.detection, tag);
            updatePhaseUI(side, 'segmentation', status.segmentation, status.data, sampleId, status.durations?.segmentation, tag);
            updatePhaseUI(side, 'metrology', status.metrology, status.data, sampleId, status.durations?.metrology, tag);

            if (status.completed) {
                clearInterval(pollIntervals[side]);
                if (statusDiv) {
                    statusDiv.innerText = "Analysis Complete!";
                    statusDiv.className = "mt-4 text-center fw-bold text-success";
                }
                if (uploadBtn) uploadBtn.disabled = false;
                displayResults(side, sampleId, tag);
                updateComparison();
            }
        } catch (e) {
            console.error("Polling error:", e);
        }
    }, 2000);
}

/**
 * Helper to load bump analysis data and UI.
 */
function loadBumpAnalysis(side, sampleId, card, tag) {
    if (card.querySelector('.bump-analysis-section') || card.dataset.loadingBumps === 'true') return;
    
    card.dataset.loadingBumps = 'true';
    fetch(`/api/bumps/${sampleId}?tag=${tag || ''}`)
        .then(res => res.json())
        .then(bumps => {
            if (bumps.good.length > 0 || bumps.bad.length > 0) {
                const content = card.querySelector('.phase-content');
                if (!content) return;
                
                // Double check to prevent duplicates
                if (content.querySelector('.bump-analysis-section')) return;

                const htmlContent = `
                    <div class="mt-4 border-top pt-3 bump-analysis-section">
                        <h6 class="text-muted mb-3 fw-bold">Bump Level Analysis</h6>
                        <div class="row g-3">
                            <div class="col-md-6">
                                <label class="small fw-bold text-success mb-1">Good Bumps</label>
                                <select class="form-select form-select-sm mb-2" onchange="window.loadBumpModel('${sampleId}', this, 'good-bump-viewer-${side}', '${tag || ''}')">
                                    <option value="">Select a bump...</option>
                                    ${bumps.good.map(b => `<option value="${b.id}" data-pos='${JSON.stringify(b.position || null)}'>${b.label}</option>`).join('')}
                                </select>
                                <model-viewer id="good-bump-viewer-${side}" camera-controls auto-rotate style="width: 100%; height: 200px; background-color: #1e293b; border-radius: 6px;" shadow-intensity="1"></model-viewer>
                                ${window.getLayerControls(`good-bump-viewer-${side}`)}
                            </div>
                            <div class="col-md-6">
                                <label class="small fw-bold text-danger mb-1">Defective Bumps</label>
                                <select class="form-select form-select-sm mb-2" onchange="window.loadBumpModel('${sampleId}', this, 'bad-bump-viewer-${side}', '${tag || ''}')">
                                    <option value="">Select a bump...</option>
                                    ${bumps.bad.map(b => `<option value="${b.id}" data-pos='${JSON.stringify(b.position || null)}'>${b.label}</option>`).join('')}
                                </select>
                                <model-viewer id="bad-bump-viewer-${side}" camera-controls auto-rotate style="width: 100%; height: 200px; background-color: #1e293b; border-radius: 6px;" shadow-intensity="1"></model-viewer>
                                ${window.getLayerControls(`bad-bump-viewer-${side}`)}
                            </div>
                        </div>
                        <div class="mt-3 text-center">
                            <button class="btn btn-outline-primary btn-sm" onclick="window.viewAllBumps('${sampleId}', '${tag || ''}')">
                                View All Bumps (3D Grid)
                            </button>
                        </div>
                    </div>
                `;
                content.insertAdjacentHTML('beforeend', htmlContent);
            }
        })
        .catch(e => console.error("Error loading bumps:", e))
        .finally(() => {
            card.dataset.loadingBumps = 'false';
        });
}

/**
 * Update the UI card for a specific phase.
 */
function updatePhaseUI(side, phase, status, data, sampleId, duration, tag) {
    const card = document.getElementById(`${side}-card-${phase}`);
    if (!card) return;

    const badge = card.querySelector('.status-badge');
    
    if (status === 'completed') {
        badge.className = 'badge bg-success status-badge';
        badge.innerHTML = 'Completed' + (duration ? ` <span class="ms-2 small text-white fw-bold" style="font-size: 0.85em;">(${duration.toFixed(1)}s)</span>` : '');
        card.style.borderLeft = '5px solid #198754'; // Green border
        
        // Special handling for detection preview
        if (phase === 'detection' && !card.querySelector('.detection-preview')) {
            const content = card.querySelector('.phase-content');
            if (content) {
                // Fetch detection details
                fetch(`/api/detection_preview/${sampleId}?tag=${tag || ''}`)
                    .then(res => res.json())
                    .then(detData => {
                        console.log("Received detection preview data:", detData);
                        
                        detectionCache[sampleId] = detData;
                        
                        // Generate unique IDs for this side
                        const uniqueId = `${side}-${sampleId}`;
                        
                        // Determine available views
                        const hasView1 = detData.view1 && detData.view1.length > 0;
                        const hasView2 = detData.view2 && detData.view2.length > 0;
                        
                        let bestIndex1 = 0;
                        let bestIndex2 = 0;
                        let html = '<div class="row g-2">';

                        if (hasView1) {
                            const frames = detData.view1;
                            const maxSlice = frames.length - 1;
                            const baseId = `view1-${uniqueId}`; // ID specific to view1
                            
                            let maxBoxes = -1;
                            frames.forEach((f, i) => { if(f.bboxes && f.bboxes.length > maxBoxes) { maxBoxes = f.bboxes.length; bestIndex1 = i; } });

                            html += `
                            <div class="${hasView2 ? 'col-md-6' : 'col-12'}">
                                <div class="d-flex justify-content-between align-items-center mb-1">
                                    <span class="badge bg-primary bg-opacity-75">View 1 (Horizontal)</span>
                                    <div class="form-check form-switch mb-0">
                                        <input class="form-check-input" type="checkbox" id="bbox-toggle-${baseId}" checked onchange="window.toggleBBoxes('${side}', '${sampleId}', this)">
                                        <label class="form-check-label small text-muted" for="bbox-toggle-${baseId}">Boxes</label>
                                    </div>
                                    <span class="badge bg-secondary" id="counter-${baseId}">${bestIndex1 + 1}/${frames.length}</span>
                                </div>
                                <div class="detection-preview position-relative">
                                    <img id="img-${baseId}" class="img-fluid rounded border w-100" style="min-height: 200px; background: #000; object-fit: contain;">
                                    <canvas id="canvas-${baseId}" class="position-absolute top-0 start-0 w-100 h-100" style="pointer-events: auto;"></canvas>
                                </div>
                                <input type="range" class="form-range mt-2" min="0" max="${maxSlice}" value="${bestIndex1}" oninput="window.updateDetectionFrame('${side}', '${sampleId}', this.value, 'view1')">
                            </div>`;
                        }

                        if (hasView2) {
                            const frames = detData.view2;
                            const maxSlice = frames.length - 1;
                            const baseId = `view2-${uniqueId}`; // ID specific to view2
                            
                            let maxBoxes = -1;
                            frames.forEach((f, i) => { if(f.bboxes && f.bboxes.length > maxBoxes) { maxBoxes = f.bboxes.length; bestIndex2 = i; } });

                            html += `
                            <div class="${hasView1 ? 'col-md-6' : 'col-12'}">
                                <div class="d-flex justify-content-between align-items-center mb-1">
                                    <span class="badge bg-info bg-opacity-75 text-dark">View 2 (Vertical)</span>
                                        <div class="form-check form-switch mb-0">
                                        <input class="form-check-input" type="checkbox" id="bbox-toggle-${baseId}" checked onchange="window.toggleBBoxes('${side}', '${sampleId}', this)">
                                        <label class="form-check-label small text-muted" for="bbox-toggle-${baseId}">Boxes</label>
                                    </div>
                                    <span class="badge bg-secondary" id="counter-${baseId}">${bestIndex2 + 1}/${frames.length}</span>
                                </div>
                                <div class="detection-preview position-relative">
                                    <img id="img-${baseId}" class="img-fluid rounded border w-100" style="min-height: 200px; background: #000; object-fit: contain;">
                                    <canvas id="canvas-${baseId}" class="position-absolute top-0 start-0 w-100 h-100" style="pointer-events: auto;"></canvas>
                                </div>
                                <input type="range" class="form-range mt-2" min="0" max="${maxSlice}" value="${bestIndex2}" oninput="window.updateDetectionFrame('${side}', '${sampleId}', this.value, 'view2')">
                            </div>`;
                        }
                        
                        html += '</div>';
                        content.innerHTML = html;

                        // Initialize frames
                        setTimeout(() => {
                            if (hasView1) window.updateDetectionFrame(side, sampleId, bestIndex1, 'view1');
                            if (hasView2) window.updateDetectionFrame(side, sampleId, bestIndex2, 'view2');
                        }, 100);
                    })
                    .catch(e => console.error("Error loading detection preview:", e));
            }
        }

        // Special handling for segmentation 3D view
        if (phase === 'segmentation') {
            // 1. Load 3D Model (if not present)
            if (!card.querySelector('model-viewer') && card.dataset.loadingModel !== 'true') {
                const content = card.querySelector('.phase-content');
                if (content) {
                    if (!content.innerHTML.includes('spinner-border')) {
                        content.innerHTML = '<div class="text-center"><div class="spinner-border text-primary" role="status"></div><p>Generating 3D Model...</p></div>';
                    }

                    card.dataset.loadingModel = 'true';
                    fetch(`/api/model/${sampleId}?tag=${tag || ''}`)
                        .then(res => res.json())
                        .then(data => {
                            let htmlContent = '';
                            if (data.url) {
                                const viewerId = `seg-viewer-${side}`;
                                htmlContent = `
                                    <div class="position-relative">
                                        <model-viewer 
                                            id="${viewerId}"
                                            src="${data.url}" 
                                            alt="3D Segmentation" 
                                            auto-rotate 
                                            camera-controls 
                                            style="width: 100%; height: 500px; background-color: #0f172a; border-radius: 8px;"
                                            shadow-intensity="1"
                                            exposure="1.2"
                                        ></model-viewer>
                                        <button class="btn btn-sm btn-outline-light position-absolute top-0 end-0 m-2" style="z-index: 10; font-size: 0.7rem;" onclick="const mv = document.getElementById('${viewerId}'); mv.cameraTarget = 'auto'; mv.fieldOfView = 'auto'; const h = mv.querySelector('.bump-indicator'); if(h) h.remove();">
                                            Reset View
                                        </button>
                                    </div>
                                    ${window.getLayerControls(viewerId)}`;
                                content.innerHTML = htmlContent;
                                loadBumpAnalysis(side, sampleId, card, tag);
                            } else {
                                content.innerHTML = '<div class="alert alert-warning">Model not available</div>';
                            }
                        })
                        .catch(err => {
                            console.error("Failed to load 3D model:", err);
                            content.innerHTML = `<div class="text-center text-muted"><div class="spinner-border spinner-border-sm text-secondary" role="status"></div><p class="small">Finalizing 3D Model...</p></div>`;
                        })
                        .finally(() => {
                            card.dataset.loadingModel = 'false';
                        });
                }
            }

            // 2. Load Bump Analysis (only if model is loaded and bumps are missing)
            // This runs on every poll until bumps are successfully loaded
            if (card.querySelector('model-viewer') && !card.querySelector('.bump-analysis-section')) {
                loadBumpAnalysis(side, sampleId, card, tag);
            }
        }

        // Special handling for metrology charts
        if (phase === 'metrology' && !card.querySelector('.metrology-charts')) {
            const content = card.querySelector('.phase-content');
            if (content) {
                window.renderMetrologyCharts(sampleId, content, side, tag);
            }
        }
        
    } else if (status === 'running') {
        badge.className = 'badge bg-primary status-badge';
        badge.innerText = 'Running...';
        card.style.borderLeft = '5px solid #0d6efd'; // Blue border
        
        if (phase === 'conversion') {
            const content = card.querySelector('.phase-content');
            const progress = data.conversion_progress || 0;
            content.innerHTML = `<div class="progress mt-2"><div class="progress-bar" role="progressbar" style="width: ${progress}%;" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100">${progress}%</div></div>`;
        }
    } else if (status === 'finalizing') {
        badge.className = 'badge bg-info text-dark status-badge';
        badge.innerText = 'Finalizing...';
        card.style.borderLeft = '5px solid #0dcaf0'; // Cyan border
        
    } else {
        badge.className = 'badge bg-secondary status-badge';
        badge.innerText = 'Pending';
        card.style.borderLeft = 'none';
    }
}

/**
 * Show results when complete.
 */
function displayResults(side, sampleId, tag) {
    const resultsSection = document.getElementById(`${side}-resultsSection`);
    if (resultsSection) resultsSection.style.display = 'block';

    const downloadBtn = document.getElementById(`${side}-downloadReportBtn`);
    if (downloadBtn) {
        downloadBtn.onclick = () => window.open(`/api/report/${sampleId}?tag=${tag || ''}`, '_blank');
    }
    
    const csvLink = document.getElementById(`${side}-csvLink`);
    let baseId = sampleId;
    const match = sampleId.match(/SN\d+/);
    if (match) {
        baseId = match[0];
    }
    const folderName = tag ? `${baseId}_${tag}` : baseId;
    if (csvLink) {
        csvLink.href = `/output/${folderName}/metrology/metrology.csv`;
    }
}

/**
 * Update the detection frame based on slider input.
 */
window.updateDetectionFrame = function(side, sampleId, index, viewName) {
    const data = detectionCache[sampleId];
    if (!data) return;

    // Use viewName if provided (new behavior), otherwise fallback to state (legacy)
    const view = viewName || detectionState[side].view;
    const frames = data[view];
    if (!frames || !frames[index]) return;

    const frame = frames[index];
    const uniqueId = `${side}-${sampleId}`;
    
    // Construct IDs based on the view
    const baseId = `${view}-${uniqueId}`;
    const imgId = `img-${baseId}`;
    const canvasId = `canvas-${baseId}`;
    const counterId = `counter-${baseId}`;

    const img = document.getElementById(imgId);
    const counter = document.getElementById(counterId);

    if (img) {
        img.src = frame.image_url;
        // Draw boxes once image loads
        img.onload = () => {
            window.drawDetectionBoxes(canvasId, imgId, frame.bboxes);
        };
        // Handle case where image loads immediately from cache
        if (img.complete && img.naturalWidth > 0) {
             window.drawDetectionBoxes(canvasId, imgId, frame.bboxes);
        }
    }
    
    if (counter) {
        counter.innerText = `${parseInt(index) + 1}/${frames.length}`;
    }
    
    // Update state cache if not multi-view or generic update
    if (!viewName) detectionState[side].slice = index;
}

/**
 * Helper to draw bounding boxes on a canvas overlay with tooltips.
 */
window.drawDetectionBoxes = function(canvasId, imgId, bboxes) {
    console.log(`drawDetectionBoxes called for ${canvasId}`);
    
    const canvas = document.getElementById(canvasId);
    const img = document.getElementById(imgId);
    if (!canvas || !img) return;
    
    // Ensure image is loaded before setting canvas size
    if (img.naturalWidth === 0) {
        return setTimeout(() => window.drawDetectionBoxes(canvasId, imgId, bboxes), 100);
    }

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#00ff00'; // Green boxes
    ctx.lineWidth = 2;
    
    if (!bboxes || bboxes.length === 0) {
        console.log(`No bounding boxes to draw for ${canvasId}`);
        // Clear canvas just in case
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }
    
    // Check if boxes are normalized (0-1) and scale them if needed
    const first = bboxes[0];
    const isNormalized = first.x1 <= 1.0 && first.x2 <= 1.0 && first.y1 <= 1.0 && first.y2 <= 1.0 && (first.x2 > 0 || first.y2 > 0);
    
    if (isNormalized) {
    }

    const scaledBoxes = bboxes.map(box => isNormalized ? {
        class_id: box.class_id,
        x1: box.x1 * canvas.width,
        y1: box.y1 * canvas.height,
        x2: box.x2 * canvas.width,
        y2: box.y2 * canvas.height
    } : box);

    scaledBoxes.forEach(box => {
        // Color based on class_id if present
        if (box.class_id !== undefined) {
            const colors = ['#00ff00', '#ff0000', '#0000ff', '#ffff00']; // 0:Green, 1:Red, 2:Blue, 3:Yellow
            ctx.strokeStyle = colors[box.class_id % colors.length];
            ctx.fillStyle = ctx.strokeStyle;
            ctx.font = '12px Arial';
            ctx.fillText(`C${box.class_id}`, box.x1, box.y1 - 5);
        } else {
            ctx.strokeStyle = '#00ff00';
        }
        ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    });

    // Tooltip logic
    let tooltip = document.getElementById('bbox-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'bbox-tooltip';
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'rgba(0, 0, 0, 0.8)';
        tooltip.style.color = 'white';
        tooltip.style.padding = '5px 10px';
        tooltip.style.borderRadius = '4px';
        tooltip.style.fontSize = '12px';
        tooltip.style.pointerEvents = 'none';
        tooltip.style.display = 'none';
        tooltip.style.zIndex = '1000';
        document.body.appendChild(tooltip);
    }

    canvas.onmousemove = function(e) {
        if (canvas.style.visibility === 'hidden') return;

        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        let found = false;
        for (let i = scaledBoxes.length - 1; i >= 0; i--) {
            const box = scaledBoxes[i];
            if (x >= box.x1 && x <= box.x2 && y >= box.y1 && y <= box.y2) {
                tooltip.style.left = (e.pageX + 10) + 'px';
                tooltip.style.top = (e.pageY + 10) + 'px';
                const cls = box.class_id !== undefined ? `Class: ${box.class_id}<br>` : '';
                tooltip.innerHTML = `<strong>Box ${i+1}</strong><br>${cls}X: ${Math.round(box.x1)}, Y: ${Math.round(box.y1)}<br>W: ${Math.round(box.x2 - box.x1)}, H: ${Math.round(box.y2 - box.y1)}`;
                tooltip.style.display = 'block';
                found = true;
                canvas.style.cursor = 'crosshair';
                break;
            }
        }
        if (!found) {
            tooltip.style.display = 'none';
            canvas.style.cursor = 'default';
        }
    };

    canvas.onmouseout = function() {
        tooltip.style.display = 'none';
        canvas.style.cursor = 'default';
    };
}

/**
 * Toggle bounding box visibility for all views of a sample simultaneously.
 */
window.toggleBBoxes = function(side, sampleId, sourceCheckbox) {
    const isChecked = sourceCheckbox.checked;
    
    ['view1', 'view2'].forEach(view => {
        const baseId = `${view}-${side}-${sampleId}`;
        const canvas = document.getElementById(`canvas-${baseId}`);
        const checkbox = document.getElementById(`bbox-toggle-${baseId}`);
        
        if (canvas) canvas.style.visibility = isChecked ? 'visible' : 'hidden';
        if (checkbox && checkbox !== sourceCheckbox) checkbox.checked = isChecked;
    });

    if (!isChecked) {
        const tooltip = document.getElementById('bbox-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    }
}

/**
 * Open a new window to view all bumps in a single 3D scene (Grid View).
 */
window.viewAllBumps = function(sampleId, tag) {
    // Open in new tab by excluding window features
    const win = window.open('', '_blank');
    if (!win) return alert("Please allow popups for this site");
    
    fetch(`/api/bumps/${sampleId}?tag=${tag || ''}`)
        .then(res => res.json())
        .then(bumps => {
            
            const allBumps = [...bumps.good, ...bumps.bad];
            const badIds = new Set(bumps.bad.map(b => b.id));
            
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;

            allBumps.forEach(b => {
                if (b.position) {
                    minX = Math.min(minX, b.position.x);
                    maxX = Math.max(maxX, b.position.x);
                    minY = Math.min(minY, b.position.y);
                    maxY = Math.max(maxY, b.position.y);
                    minZ = Math.min(minZ, b.position.z);
                    maxZ = Math.max(maxZ, b.position.z);
                }
            });

            const centerX = minX !== Infinity ? (minX + maxX) / 2 : 0;
            const centerY = minY !== Infinity ? (minY + maxY) / 2 : 0;
            const centerZ = minZ !== Infinity ? (minZ + maxZ) / 2 : 0;

            const extentX = maxX !== Infinity ? (maxX - minX) : 100;
            const extentY = maxY !== Infinity ? (maxY - minY) : 100;
            const maxExtent = Math.max(extentX, extentY) || 100;
            const posScale = 100.0 / maxExtent;

            win.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>All Bumps - ${sampleId}</title>
                    <style>body { margin: 0; overflow: hidden; background: #111; color: #fff; font-family: sans-serif; }</style>
                    <script async src="https://unpkg.com/es-module-shims@1.6.3/dist/es-module-shims.js"></script>
                <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.3.0/model-viewer.min.js"></script>
                    <script type="importmap">
                      {
                        "imports": {
                          "three": "https://unpkg.com/three@0.154.0/build/three.module.js",
                          "three/addons/": "https://unpkg.com/three@0.154.0/examples/jsm/"
                        }
                      }
                    </script>
                </head>
                <body>
                    <div style="position: absolute; top: 10px; left: 10px; z-index: 100; background: rgba(0,0,0,0.5); padding: 10px; border-radius: 4px;">
                        <h3 style="margin: 0 0 5px;">${sampleId} Bump Grid</h3>
                        <span style="color: #4ade80">● Good: ${bumps.good.length}</span> | 
                        <span style="color: #ef4444">● Defective: ${bumps.bad.length}</span>
                        <div class="small" style="margin-top: 5px; color: #aaa;">Left Click: Rotate | Right Click: Pan | Scroll: Zoom</div>
                    </div>
                    <script type="module">
                        import * as THREE from 'three';
                        import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
                        import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
                        import { FontLoader } from 'three/addons/loaders/FontLoader.js';
                        import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

                        const scene = new THREE.Scene();
                        scene.background = new THREE.Color(0x111111);
                        
                        const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
                        camera.up.set(0, 0, 1); // Set Z as the vertical axis to match NIfTI/GLTF native space
                        camera.position.set(0, -60, 60); // View from a top-angled isometric perspective
                        
                        const renderer = new THREE.WebGLRenderer({ antialias: true });
                        renderer.setSize(window.innerWidth, window.innerHeight);
                        document.body.appendChild(renderer.domElement);
                        
                        const controls = new OrbitControls(camera, renderer.domElement);
                        controls.enableDamping = true;
                        
                        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
                        scene.add(ambientLight);
                        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
                        dirLight.position.set(10, -10, 20);
                        scene.add(dirLight);

                        const loader = new GLTFLoader();
                        const fontLoader = new FontLoader();
                        
                        const bumps = ${JSON.stringify(allBumps)};
                        const badIds = new Set(${JSON.stringify([...badIds])});
                        
                        const centerX = ${centerX};
                        const centerY = ${centerY};
                        const centerZ = ${centerZ};
                        const posScale = ${posScale};
                        
                        // Load font for labels
                        fontLoader.load('https://unpkg.com/three@0.154.0/examples/fonts/helvetiker_regular.typeface.json', (font) => {
                            
                            bumps.forEach((bump, index) => {
                                const apiUrl = \`/api/bump_model/${sampleId}/\${bump.id}?tag=${tag || ''}\`;
                                
                                // Fetch the actual GLTF URL from API (since the endpoint returns JSON {url: "..."})
                                fetch(apiUrl)
                                    .then(res => res.json())
                                    .then(data => {
                                        if (!data.url) return;
                                        
                                        let x = 0, y = 0, z = 0;
                                        const explodeFactor = 2.5; // Increases grid spacing to prevent congestion
                                        if (bump.position) {
                                            x = (bump.position.x - centerX) * posScale * explodeFactor;
                                            y = (bump.position.y - centerY) * posScale * explodeFactor;
                                            z = (bump.position.z - centerZ) * posScale * explodeFactor;
                                        }
                                        
                                        loader.load(data.url, (gltf) => {
                                            const model = gltf.scene;
                                            const box = new THREE.Box3().setFromObject(model);
                                            const size = new THREE.Vector3();
                                            box.getSize(size);
                                            const center = box.getCenter(new THREE.Vector3());
                                            
                                            model.scale.set(posScale, posScale, posScale);
                                            model.position.copy(center).multiplyScalar(-posScale);
                                            
                                            const group = new THREE.Group();
                                            group.add(model);
                                            group.position.set(x, y, z);
                                            
                                            const scaledMaxDim = Math.max(size.x, size.y, size.z) * posScale || 2.0;
                                            const ringRadius = scaledMaxDim * 0.6;
                                            
                                            // Status Ring
                                            const isBad = badIds.has(bump.id);
                                            const color = isBad ? 0xef4444 : 0x4ade80;
                                            const ringGeo = new THREE.RingGeometry(ringRadius, ringRadius * 1.1, 32);
                                            const ringMat = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide });
                                            const ring = new THREE.Mesh(ringGeo, ringMat);
                                            group.add(ring);

                                            // Text Label
                                            const labelText = bump.label.replace('Bump ', ''); // Turns "Bump 12 (Void)" into "12 (Void)"
                                            const textScale = scaledMaxDim * 0.15;
                                            const textGeo = new TextGeometry(labelText, {
                                                font: font,
                                                size: textScale,
                                                height: textScale * 0.2,
                                            });
                                            textGeo.computeBoundingBox();
                                            const textWidth = textGeo.boundingBox.max.x - textGeo.boundingBox.min.x;
                                            const textMat = new THREE.MeshBasicMaterial({ color: isBad ? 0xffcccc : 0xffffff });
                                            const textMesh = new THREE.Mesh(textGeo, textMat);
                                            textMesh.position.set(-textWidth / 2, 0, scaledMaxDim * 0.7); // Position above bump in Z
                                            textMesh.rotation.x = Math.PI / 2; // Tilt text to face the angled camera
                                            
                                            group.add(textMesh);
                                            
                                            scene.add(group);
                                        });
                                    })
                                    .catch(e => console.error("Error loading bump model:", e));
                            });
                        });

                        function animate() {
                            requestAnimationFrame(animate);
                            controls.update();
                            renderer.render(scene, camera);
                        }
                        
                        window.addEventListener('resize', () => {
                            camera.aspect = window.innerWidth / window.innerHeight;
                            camera.updateProjectionMatrix();
                            renderer.setSize(window.innerWidth, window.innerHeight);
                        });

                        animate();
                    </script>
                </body></html>`);
            win.document.close();
        })
        .catch(e => {
            if(win) win.close();
            alert("Error viewing bumps: " + e.message);
        });
}

/**
 * Load a specific bump model into a viewer.
 */
window.loadBumpModel = function(sampleId, selectOrId, viewerId, tag) {
    let bumpId = selectOrId;
    let position = null;
    
    if (typeof selectOrId === 'object') {
        bumpId = selectOrId.value;
        if (!bumpId) return; // Do nothing if "Select a bump..." is chosen
        const option = selectOrId.options[selectOrId.selectedIndex];
        if (option.dataset.pos) {
            position = JSON.parse(option.dataset.pos);
        }
    }

    const viewer = document.getElementById(viewerId);
    if (!viewer || !bumpId) return;
    
    // Reset UI controls to default state
    window.resetLayerControls(viewerId);
    
    viewer.src = ''; // Clear current
    viewer.alt = "Loading...";
    
    // Show loading state
    const parent = viewer.parentElement;
    let loader = parent.querySelector('.bump-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.className = 'bump-loader position-absolute top-50 start-50 translate-middle text-center';
        loader.innerHTML = '<div class="spinner-border spinner-border-sm text-light" role="status"></div>';
        parent.style.position = 'relative';
        parent.appendChild(loader);
    }
    loader.style.display = 'block';
    viewer.style.opacity = '0.3';
    
    fetch(`/api/bump_model/${sampleId}/${bumpId}?tag=${tag || ''}`)
        .then(res => {
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return res.json();
        })
        .then(data => {
            if (data.url) {
                viewer.src = data.url;
                viewer.alt = `Bump ${bumpId}`;
            }
        })
        .catch(e => {
            console.error(e);
            viewer.alt = "Failed to load";
            if (loader) {
                loader.innerHTML = '<span class="badge bg-danger">Error</span>';
            }
        })
        .finally(() => {
            viewer.style.opacity = '1';
            if (loader && viewer.src) loader.style.display = 'none';
        });
        
    // Focus main model on the selected bump
    if (position) {
        const side = viewerId.includes('left') ? 'left' : 'right';
        const mainViewer = document.getElementById(`seg-viewer-${side}`);
        if (mainViewer) {
            mainViewer.cameraTarget = `${position.x}m ${position.y}m ${position.z}m`;
            mainViewer.fieldOfView = '20deg'; // Zoom in (slightly wider to see context)
            
            // Add visual indicator
            const existing = mainViewer.querySelector('.bump-indicator');
            if (existing) existing.remove();
            
            const hotspot = document.createElement('button');
            hotspot.className = 'bump-indicator';
            hotspot.slot = 'hotspot-selected';
            hotspot.dataset.position = `${position.x}m ${position.y}m ${position.z}m`;
            
            // Reset default button styles
            hotspot.style.display = 'block';
            hotspot.style.background = 'transparent';
            hotspot.style.border = 'none';
            hotspot.style.padding = '0';
            hotspot.style.width = '20px';
            hotspot.style.height = '20px';
            hotspot.style.cursor = 'pointer';

            hotspot.innerHTML = `
                <div class="bump-marker-container">
                    <div class="bump-ring"></div>
                    <div class="bump-dot"></div>
                    <div class="bump-arrow-static">▼</div>
                </div>
                <div class="bump-tooltip" style="
                    position: absolute; 
                    top: -45px; 
                    left: 50%; 
                    transform: translateX(-50%); 
                    background: rgba(0, 0, 0, 0.8); 
                    color: white; 
                    padding: 4px 8px; 
                    border-radius: 4px; 
                    font-size: 12px; 
                    white-space: nowrap; 
                    pointer-events: none; 
                    opacity: 0; 
                    transition: opacity 0.2s;">
                    Bump ${bumpId}
                </div>
            `;
            
            // Add hover listeners
            hotspot.addEventListener('mouseenter', () => {
                const tip = hotspot.querySelector('.bump-tooltip');
                if(tip) tip.style.opacity = '1';
            });
            hotspot.addEventListener('mouseleave', () => {
                const tip = hotspot.querySelector('.bump-tooltip');
                if(tip) tip.style.opacity = '0';
            });
            
            mainViewer.appendChild(hotspot);
        }
    }
}

/**
 * Reset layer controls (badges and slider) to default state.
 */
window.resetLayerControls = function(viewerId) {
    const viewer = document.getElementById(viewerId);
    if (!viewer) return;
    
    // The controls are in the next element sibling (div created by getLayerControls)
    const controls = viewer.nextElementSibling;
    if (!controls) return;
    
    // Reset badges
    const badges = controls.querySelectorAll('.badge');
    badges.forEach(b => {
        b.style.opacity = '1';
        b.style.textDecoration = 'none';
    });
    
    // Reset slider
    const slider = controls.querySelector('input[type="range"]');
    if (slider) slider.value = 1;
    
    // Reset percentage text
    const valDisplay = document.getElementById(`${viewerId}-opacity-val`);
    if (valDisplay) valDisplay.innerText = '100%';
}

/**
 * Render Metrology Charts using Chart.js
 */
window.renderMetrologyCharts = function(sampleId, container, side, tag) {
    container.innerHTML = `
        <div class="metrology-charts row g-3 mt-2">
            <div class="col-md-6">
                <div class="p-2 border rounded bg-dark" style="height: 300px; position: relative;">
                    <canvas id="chart-pie-${side}"></canvas>
                </div>
            </div>
            <div class="col-md-6">
                <div class="p-2 border rounded bg-dark" style="height: 300px; position: relative;">
                    <span id="total-bumps-${side}" style="position: absolute; top: 15px; left: 20px; color: #cbd5e1; font-size: 13px; font-weight: bold; z-index: 10;">Total Bumps: ...</span>
                    <canvas id="chart-defects-${side}"></canvas>
                </div>
            </div>
            <div class="col-md-6">
                <div class="p-2 border rounded bg-dark" style="height: 300px; position: relative;">
                    <canvas id="chart-blt-${side}"></canvas>
                </div>
            </div>
            <div class="col-md-6">
                <div class="p-2 border rounded bg-dark" style="height: 300px; position: relative;">
                    <canvas id="chart-void-${side}"></canvas>
                </div>
            </div>
        </div>
    `;
    
    // Register the datalabels plugin if available
    if (typeof ChartDataLabels !== 'undefined') {
        Chart.register(ChartDataLabels);
    }

    fetch(`/api/metrology_stats/${sampleId}?tag=${tag || ''}`)
        .then(res => res.json())
        .then(data => {
            const totalBadge = document.getElementById(`total-bumps-${side}`);
            if (totalBadge && data.summary) {
                totalBadge.innerText = `Total Bumps: ${data.summary.total_bumps}`;
            }

            // Pie Chart
            new Chart(document.getElementById(`chart-pie-${side}`), {
                type: 'doughnut',
                data: {
                    labels: ['Good Bumps', 'Defective Bumps'],
                    datasets: [{
                        data: data.pie_data,
                        backgroundColor: ['#198754', '#dc3545']
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    plugins: { 
                        title: { display: true, text: 'Yield Analysis', color: 'white' }, 
                        legend: { labels: { color: 'white' } },
                        datalabels: {
                            color: 'white',
                            font: { weight: 'bold', size: 14 }
                        }
                    }
                }
            });
            
            // Defect Types
            new Chart(document.getElementById(`chart-defects-${side}`), {
                type: 'bar',
                data: {
                    labels: Object.keys(data.defect_counts),
                    datasets: [{
                        label: 'Count',
                        data: Object.values(data.defect_counts),
                        backgroundColor: '#ffc107'
                    }]
                },
                options: {
                    maintainAspectRatio: false,
                    layout: { padding: { top: 5 } },
                    plugins: { 
                        title: { display: true, text: 'Defect Types', color: 'white' }, 
                        legend: { display: false },
                        datalabels: {
                            color: 'white',
                            anchor: 'end',
                            align: 'end',
                            font: { weight: 'bold' }
                        }
                    },
                    scales: { 
                    y: { 
                        ticks: { color: 'white' },
                        max: data.pie_data[1] + 5
                    }, 
                    x: { ticks: { color: 'white' } } 
                }
                }
            });
            
            // BLT Hist
            if (data.blt_hist) {
                new Chart(document.getElementById(`chart-blt-${side}`), {
                    type: 'bar',
                    data: {
                        labels: data.blt_hist.labels,
                        datasets: [{
                            label: 'Bumps',
                            data: data.blt_hist.counts,
                            backgroundColor: '#0d6efd'
                        }]
                    },
                    options: {
                        maintainAspectRatio: false,
                        plugins: { 
                            title: { display: true, text: 'BLT Distribution (µm)', color: 'white' }, 
                            legend: { display: false },
                            datalabels: { display: false }
                        },
                        scales: { y: { ticks: { color: 'white' } }, x: { ticks: { color: 'white' } } }
                    }
                });
            }
            
            // Void Hist
            if (data.void_hist) {
                new Chart(document.getElementById(`chart-void-${side}`), {
                    type: 'bar',
                    data: {
                        labels: data.void_hist.labels,
                        datasets: [{
                            label: 'Bumps',
                            data: data.void_hist.counts,
                            backgroundColor: '#6610f2'
                        }]
                    },
                    options: {
                        maintainAspectRatio: false,
                        plugins: { 
                            title: { display: true, text: 'Void to Solder Ratio Distribution', color: 'white' }, 
                            legend: { display: false },
                            datalabels: { display: false }
                        },
                        scales: { y: { ticks: { color: 'white' } }, x: { ticks: { color: 'white' } } }
                    }
                });
            }
        });
}

/**
 * Update the comparison table if both samples are available.
 */
window.updateComparison = async function() {
    const leftSample = currentSamples.left;
    const rightSample = currentSamples.right;
    const section = document.getElementById('comparison-section');
    if (!leftSample.id || !rightSample.id) return;
    
    // Check if we are in single view mode (right column hidden)
    const colRight = document.getElementById('col-right');
    if (colRight && colRight.classList.contains('d-none')) {
        if(section) section.style.display = 'none';
        return;
    }
    
    try {
        const [leftRes, rightRes] = await Promise.all([
            fetch(`/api/metrology_stats/${leftSample.id}?tag=${leftSample.tag || ''}`),
            fetch(`/api/metrology_stats/${rightSample.id}?tag=${rightSample.tag || ''}`)
        ]);

        if (!leftRes.ok || !rightRes.ok) return;

        const leftStats = await leftRes.json();
        const rightStats = await rightRes.json();
        const leftLabel = leftSample.tag ? `${leftSample.id}_${leftSample.tag}` : leftSample.id;
        const rightLabel = rightSample.tag ? `${rightSample.id}_${rightSample.tag}` : rightSample.id;
        if(section) section.style.display = 'block';
        
        document.getElementById('comp-left-header').innerText = leftLabel;
        document.getElementById('comp-right-header').innerText = rightLabel;

        const tbody = document.querySelector('#comparison-table tbody');
        tbody.innerHTML = '';

        const metrics = [
            { key: 'total_bumps', label: 'Total Bumps', unit: '' },
            { key: 'yield_rate', label: 'Yield Rate', unit: '%' },
            { key: 'mean_blt', label: 'Avg. BLT', unit: 'µm' },
            { key: 'mean_void', label: 'Avg. Void Ratio', unit: '%' }
        ];

        metrics.forEach(m => {
            const lVal = leftStats.summary[m.key] || 0;
            const rVal = rightStats.summary[m.key] || 0;
            const diff = rVal - lVal;
            const diffStr = (diff > 0 ? '+' : '') + diff.toFixed(2) + m.unit;
            
            let diffClass = 'text-muted';
            if (m.key === 'yield_rate') diffClass = diff >= 0 ? 'text-success' : 'text-danger';
            if (m.key === 'mean_void') diffClass = diff <= 0 ? 'text-success' : 'text-danger';
            if (m.key === 'mean_blt') diffClass = Math.abs(diff) < 1.0 ? 'text-success' : 'text-warning';

            const row = `
                <tr>
                    <td class="text-start fw-bold">${m.label}</td>
                    <td>${lVal.toFixed(2)}${m.unit}</td>
                    <td>${rVal.toFixed(2)}${m.unit}</td>
                    <td class="${diffClass} fw-bold">${diffStr}</td>
                </tr>
            `;
            tbody.innerHTML += row;
        });
    } catch (e) {
        console.error("Error updating comparison:", e);
    }
}

/**
 * Export comparison table to CSV
 */
window.exportComparisonCSV = function() {
    const leftSample = currentSamples.left;
    const rightSample = currentSamples.right;
    if (!leftSample.id || !rightSample.id) {
        alert("No comparison data available to export.");
        return;
    }

    const rows = [];
    
    // Headers
    rows.push(['Metric', `Left Sample (${leftSample.id}_${leftSample.tag})`, `Right Sample (${rightSample.id}_${rightSample.tag})`, 'Difference']);

    // Data from table
    const tableBody = document.querySelector('#comparison-table tbody');
    if (!tableBody) return;
    
    const trs = tableBody.querySelectorAll('tr');
    
    trs.forEach(tr => {
        const cells = tr.querySelectorAll('td');
        const rowData = [
            cells[0].innerText, // Metric
            cells[1].innerText, // Left
            cells[2].innerText, // Right
            cells[3].innerText  // Diff
        ];
        // Simple CSV escaping
        rows.push(rowData.map(t => t.includes(',') ? `"${t}"` : t));
    });

    // Convert to CSV string
    const csvContent = rows.map(e => e.join(",")).join("\n");
    
    // Download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `comparison_${leftSample.id}_vs_${rightSample.id}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Toggle between Single and Comparative views.
 */
window.toggleView = function(mode) {
    const colLeft = document.getElementById('col-left');
    const colRight = document.getElementById('col-right');
    const compSection = document.getElementById('comparison-section');
    const modeSingleBtn = document.getElementById('modeSingle');
    const modeCompareBtn = document.getElementById('modeCompare');
    const headerLeft = document.getElementById('header-left');

    if (mode === 'single') {
        // Update buttons
        if(modeSingleBtn) modeSingleBtn.checked = true;
        if(modeCompareBtn) modeCompareBtn.checked = false;

        // Hide right column
        if(colRight) colRight.classList.add('d-none');
        
        // Adjust left column to be centered
        if(colLeft) {
            colLeft.className = 'col-lg-8 offset-lg-2';
            colLeft.classList.remove('border-end');
        }
        
        // Hide comparison section
        if(compSection) compSection.style.display = 'none';

        // Update header text
        if(headerLeft) headerLeft.innerText = "Sample Analysis";
        
    } else {
        // Update buttons
        if(modeSingleBtn) modeSingleBtn.checked = false;
        if(modeCompareBtn) modeCompareBtn.checked = true;

        // Show right column
        if(colRight) colRight.classList.remove('d-none');
        
        // Adjust left column to be half width
        if(colLeft) {
            colLeft.className = 'col-lg-6 border-end';
        }
        
        // Update comparison visibility
        window.updateComparison();

        // Update header text
        if(headerLeft) headerLeft.innerText = "Left Sample";
    }
}

// Initialize to Single View on load
document.addEventListener('DOMContentLoaded', () => {
    window.toggleView('single');
});

/**
 * Generate HTML for layer controls.
 */
window.getLayerControls = function(viewerId) {
    return `
    <div class="mt-2 d-flex flex-column align-items-center">
        <div class="d-flex gap-2 justify-content-center flex-wrap">
            <span class="badge rounded-pill" style="background-color: red; cursor: pointer; user-select: none; transition: all 0.2s;" onclick="window.toggleLayer('${viewerId}', 'red', this)">Copper Pillar</span>
            <span class="badge rounded-pill" style="background-color: green; cursor: pointer; user-select: none; transition: all 0.2s;" onclick="window.toggleLayer('${viewerId}', 'green', this)">Solder</span>
            <span class="badge rounded-pill" style="background-color: blue; cursor: pointer; user-select: none; transition: all 0.2s;" onclick="window.toggleLayer('${viewerId}', 'blue', this)">Void</span>
            <span class="badge rounded-pill" style="background-color: yellow; color: black; cursor: pointer; user-select: none; transition: all 0.2s;" onclick="window.toggleLayer('${viewerId}', 'yellow', this)">Copper Pad</span>
        </div>
        <div class="mt-2 d-flex align-items-center gap-2">
            <label class="small text-muted mb-0" style="font-size: 0.75rem;">Solder Opacity</label>
            <input type="range" class="form-range" style="width: 100px;" min="0" max="1" step="0.1" value="1" oninput="window.setSolderOpacity('${viewerId}', this.value)">
            <span id="${viewerId}-opacity-val" class="small text-muted" style="font-size: 0.75rem; min-width: 35px;">100%</span>
        </div>
    </div>`;
}

/**
 * Toggle visibility of a specific layer in the 3D model.
 */
window.toggleLayer = function(viewerId, color, btn) {
    const viewer = document.getElementById(viewerId);
    if (!viewer || !viewer.model) return;
    
    const isHidden = btn.style.opacity === '0.4';
    
    // Toggle state
    if (isHidden) {
        btn.style.opacity = '1';
        btn.style.textDecoration = 'none';
    } else {
        btn.style.opacity = '0.4';
        btn.style.textDecoration = 'line-through';
    }
    
    const targetAlpha = isHidden ? 1.0 : 0.0;

    for (const material of viewer.model.materials) {
        const pbr = material.pbrMetallicRoughness;
        const c = pbr.baseColorFactor; // [r, g, b, a]
        
        let match = false;
        // Simple color matching logic based on the known colors
        if (color === 'red' && c[0] > 0.8 && c[1] < 0.2 && c[2] < 0.2) match = true;
        else if (color === 'green' && c[1] > 0.4 && c[0] < 0.2 && c[2] < 0.2) match = true;
        else if (color === 'blue' && c[2] > 0.8 && c[0] < 0.2 && c[1] < 0.2) match = true;
        else if (color === 'yellow' && c[0] > 0.8 && c[1] > 0.8 && c[2] < 0.2) match = true;
        
        if (match) {
            pbr.setBaseColorFactor([c[0], c[1], c[2], targetAlpha]);
            material.setAlphaMode(targetAlpha < 1.0 ? 'BLEND' : 'OPAQUE');
        }
    }
}

/**
 * Set opacity for Solder layer only.
 */
window.setSolderOpacity = function(viewerId, opacity) {
    // Update percentage text
    const display = document.getElementById(`${viewerId}-opacity-val`);
    if (display) {
        display.innerText = `${Math.round(parseFloat(opacity) * 100)}%`;
    }

    const viewer = document.getElementById(viewerId);
    if (!viewer || !viewer.model) return;
    
    opacity = parseFloat(opacity);

    for (const material of viewer.model.materials) {
        const pbr = material.pbrMetallicRoughness;
        const c = pbr.baseColorFactor; // [r, g, b, a]
        
        // Check if it is Solder (Green)
        const isSolder = (c[1] > 0.4 && c[0] < 0.2 && c[2] < 0.2);
        
        if (isSolder) {
            pbr.setBaseColorFactor([c[0], c[1], c[2], opacity]);
            material.setAlphaMode(opacity < 1.0 ? 'BLEND' : 'OPAQUE');
        }
    }
}

/**
 * Check and display processing status (Green Tick / Yellow Dot) for the selected Sample+Tag combination.
 * This provides a visual cue "beside the button" before loading.
 */
window.checkRunStatus = async function(side) {
    const select = document.getElementById(`${side}-sampleSelect`);
    const modelSelect = document.getElementById(`${side}-modelSelect`);
    if (!select) return;
    
    const sampleId = select.value;
    const tag = modelSelect ? modelSelect.value : '';
    
    // Element to display the status icon
    let statusContainer = document.getElementById(`${side}-run-status`);
    
    // If container doesn't exist, create it and append it after the inputs/button
    if (!statusContainer && select.parentElement) {
        statusContainer = document.createElement('span');
        statusContainer.id = `${side}-run-status`;
        statusContainer.className = "ms-2 fw-bold align-middle";
        statusContainer.style.fontSize = "0.9rem";
        
        // Append to the parent container of the select/button group
        // Try to append after the load button or select
        const btn = document.querySelector(`button[onclick*="loadSample('${side}')"]`);
        if (btn && btn.parentNode) {
             btn.parentNode.appendChild(statusContainer);
             // Restore button border radius if it was lost due to input-group behavior
             // Since we added a span after the button, the button is no longer last.
             btn.style.borderTopRightRadius = "var(--bs-border-radius, 0.375rem)";
             btn.style.borderBottomRightRadius = "var(--bs-border-radius, 0.375rem)";
        } else {
             select.parentElement.appendChild(statusContainer);
        }
    }

    if (!sampleId) {
        if (statusContainer) statusContainer.innerHTML = '';
        return;
    }
    
    // Show loading spinner briefly
    if (statusContainer) statusContainer.innerHTML = '<div class="spinner-border spinner-border-sm text-secondary" role="status"></div>';

    try {
        const response = await fetch(`/api/status/${sampleId}?tag=${tag || ''}`);
        const status = await response.json();
        
        if (status.completed) {
            statusContainer.innerHTML = '<span class="badge rounded-pill bg-success bg-opacity-10 text-success border border-success px-3" style="font-weight: 500; letter-spacing: 0.5px; font-size: 1rem;">Processed</span>';
        } else {
            statusContainer.innerHTML = '<span class="badge rounded-pill bg-warning bg-opacity-10 text-warning border border-warning px-3" style="font-weight: 500; letter-spacing: 0.5px; font-size: 1rem;">Not Processed</span>';
        }
    } catch (e) {
        console.error("Status check failed", e);
        if (statusContainer) statusContainer.innerHTML = '<span class="text-muted">?</span>';
    }
}

// Expose to global scope for HTML onclick
window.handleUpload = handleUpload;

// Initialize listeners for dynamic status checking
document.addEventListener('DOMContentLoaded', () => {
    // Dynamically fetch and populate available models
    fetch('/api/models')
        .then(res => res.json())
        .then(data => {
            if (data.models && data.models.length > 0) {
                ['left', 'right'].forEach(side => {
                    const modelSelect = document.getElementById(`${side}-modelSelect`);
                    if (modelSelect) {
                        modelSelect.innerHTML = ''; // Clear default hardcoded options
                        data.models.forEach(modelTag => {
                            const option = document.createElement('option');
                            option.value = modelTag;
                            option.text = modelTag;
                            modelSelect.appendChild(option);
                        });
                        window.checkRunStatus(side); // Re-check status for the new default selection
                    }
                });
            }
        })
        .catch(e => console.error("Failed to fetch dynamic models:", e));

    ['left', 'right'].forEach(side => {
        const sampleSelect = document.getElementById(`${side}-sampleSelect`);
        const modelSelect = document.getElementById(`${side}-modelSelect`);
        
        if (sampleSelect) {
            // Clean up dropdown options to remove any server-rendered status icons (🟡, ✅)
            Array.from(sampleSelect.options).forEach(opt => {
                opt.text = opt.text.replace(/[\u2705\uD83D\uDFE1\uD83D\uDFE0\u26A0\uFE0F]/g, '').trim();
            });

            sampleSelect.addEventListener('change', () => window.checkRunStatus(side));
            // Check on load if value exists
            if (sampleSelect.value) window.checkRunStatus(side);
        }
        
        if (modelSelect) {
            modelSelect.addEventListener('change', () => window.checkRunStatus(side));
        }
    });
});

/**
 * Open a new window to view all bumps in a single 3D scene (Grid View).
 */
window.viewAllBumps = function(sampleId, tag) {
    // Open in new tab by excluding window features
    const win = window.open('', '_blank');
    if (!win) return alert("Please allow popups for this site");
    
    fetch(`/api/bumps/${sampleId}?tag=${tag || ''}`)
        .then(res => res.json())
        .then(bumps => {
            
            const allBumps = [...bumps.good, ...bumps.bad];
            const badIds = new Set(bumps.bad.map(b => b.id));
            
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;

            allBumps.forEach(b => {
                if (b.position) {
                    minX = Math.min(minX, b.position.x);
                    maxX = Math.max(maxX, b.position.x);
                    minY = Math.min(minY, b.position.y);
                    maxY = Math.max(maxY, b.position.y);
                    minZ = Math.min(minZ, b.position.z);
                    maxZ = Math.max(maxZ, b.position.z);
                }
            });

            const centerX = minX !== Infinity ? (minX + maxX) / 2 : 0;
            const centerY = minY !== Infinity ? (minY + maxY) / 2 : 0;
            const centerZ = minZ !== Infinity ? (minZ + maxZ) / 2 : 0;

            const extentX = maxX !== Infinity ? (maxX - minX) : 100;
            const extentY = maxY !== Infinity ? (maxY - minY) : 100;
            const maxExtent = Math.max(extentX, extentY) || 100;
            const posScale = 100.0 / maxExtent;

            win.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>All Bumps - ${sampleId}</title>
                    <style>body { margin: 0; overflow: hidden; background: #111; color: #fff; font-family: sans-serif; }</style>
                    <script async src="https://unpkg.com/es-module-shims@1.6.3/dist/es-module-shims.js"></script>
                    <script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.3.0/model-viewer.min.js"></script>
                    <script type="importmap">
                      {
                        "imports": {
                          "three": "https://unpkg.com/three@0.154.0/build/three.module.js",
                          "three/addons/": "https://unpkg.com/three@0.154.0/examples/jsm/"
                        }
                      }
                    </script>
                </head>
                <body>
                    <div style="position: absolute; top: 10px; left: 10px; z-index: 100; background: rgba(0,0,0,0.5); padding: 10px; border-radius: 4px;">
                        <h3 style="margin: 0 0 5px;">${sampleId} Bump Grid</h3>
                        <span style="color: #4ade80">● Good: ${bumps.good.length}</span> | 
                        <span style="color: #ef4444">● Defective: ${bumps.bad.length}</span>
                        <div class="small" style="margin-top: 5px; color: #aaa;">Left Click: Rotate | Right Click: Pan | Scroll: Zoom</div>
                        <div style="margin-top: 10px;">
                            <button id="toggleColorsBtn" style="padding: 4px 8px; font-size: 12px; cursor: pointer; margin-right: 5px; background: #3b82f6; color: white; border: none; border-radius: 3px;">View: Analyzed</button>
                            <button id="toggleGoodBumpsBtn" style="padding: 4px 8px; font-size: 12px; cursor: pointer; margin-right: 5px;">Hide Good Bumps</button>
                            <button id="toggleBadBumpsBtn" style="padding: 4px 8px; font-size: 12px; cursor: pointer;">Hide Defective Bumps</button>
                            <button id="exportImageBtn" style="padding: 4px 8px; font-size: 12px; cursor: pointer; margin-left: 5px; background: #10b981; color: white; border: none; border-radius: 3px;">Export Image</button>
                        </div>
                        <div style="margin-top: 10px; display: flex; align-items: center;">
                            <label style="font-size: 12px; margin-right: 5px;">Solder Opacity:</label>
                            <input type="range" id="solderOpacitySlider" min="0" max="1" step="0.1" value="1" style="vertical-align: middle;">
                            <span id="solderOpacityVal" style="font-size: 12px; margin-left: 5px;">100%</span>
                        </div>
                        <div style="margin-top: 10px; display: flex; gap: 5px; flex-wrap: wrap;" id="layerControls">
                            <span class="legend-badge" data-color="red" style="padding: 4px 8px; border-radius: 12px; font-size: 11px; background-color: red; color: white; cursor: pointer; user-select: none; transition: all 0.2s;">Copper Pillar</span>
                            <span class="legend-badge" data-color="green" style="padding: 4px 8px; border-radius: 12px; font-size: 11px; background-color: green; color: white; cursor: pointer; user-select: none; transition: all 0.2s;">Solder</span>
                            <span class="legend-badge" data-color="blue" style="padding: 4px 8px; border-radius: 12px; font-size: 11px; background-color: blue; color: white; cursor: pointer; user-select: none; transition: all 0.2s;">Void</span>
                            <span class="legend-badge" data-color="yellow" style="padding: 4px 8px; border-radius: 12px; font-size: 11px; background-color: yellow; color: black; cursor: pointer; user-select: none; transition: all 0.2s;">Copper Pad</span>
                        </div>
                        <datalist id="bumpList">
                            ${allBumps.map(b => `<option value="${b.id}">`).join('')}
                        </datalist>
                        <div style="margin-top: 10px; display: flex; align-items: center;">
                            <input type="text" id="searchBumpId" list="bumpList" placeholder="Search Bump ID..." style="font-size: 12px; padding: 4px; width: 120px; margin-right: 5px; background: #222; color: #fff; border: 1px solid #444; border-radius: 3px;">
                            <button id="searchBtn" style="padding: 4px 8px; font-size: 12px; cursor: pointer; background: #3b82f6; color: white; border: none; border-radius: 3px;">Find</button>
                        </div>
                        <div id="bumpDetailsPanel" style="margin-top: 15px; padding: 12px; background: rgba(30, 41, 59, 0.9); border-radius: 6px; display: none; font-size: 13px; border: 1px solid #475569; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
                            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #475569; padding-bottom: 6px; margin-bottom: 8px;">
                                <h4 id="bumpDetailsTitle" style="margin: 0; color: #38bdf8; font-size: 15px;">Bump Details</h4>
                                <span id="closeDetailsBtn" style="cursor: pointer; color: #94a3b8; font-weight: bold; font-size: 14px; padding: 0 4px;">✕</span>
                            </div>
                        <div id="bumpDetailsContent" style="min-width: 260px;">
                            <div id="miniViewerContainer" style="display: none; margin-bottom: 12px; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.5); background-color: #0f172a; border: 1px solid #475569;">
                                <model-viewer id="miniModelViewer" auto-rotate camera-controls style="width: 100%; height: 220px;" shadow-intensity="1"></model-viewer>
                                <div style="padding: 6px 10px; display: flex; align-items: center; background: #1e293b; border-top: 1px solid #475569;">
                                    <span style="font-size: 11px; color: #cbd5e1; margin-right: 8px;">Solder Opacity:</span>
                                    <input id="miniSolderSlider" type="range" min="0" max="1" step="0.1" value="1" style="flex-grow: 1; cursor: pointer;" oninput="window.setMiniSolderOpacity(this.value)">
                                    <span id="miniSolderOpacityVal" style="font-size: 11px; color: #cbd5e1; margin-left: 8px; min-width: 32px; text-align: right;">100%</span>
                                </div>
                            </div>
                            <div id="miniMetricsContainer"></div>
                        </div>
                        </div>
                    </div>
                    <script type="module">
                        import * as THREE from 'three';
                        import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
                        import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
                        import { FontLoader } from 'three/addons/loaders/FontLoader.js';
                        import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

                        const scene = new THREE.Scene();
                        scene.background = new THREE.Color(0x111111);
                        
                        const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
                        camera.position.set(0, 40, 40);
                        
                        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
                        renderer.setSize(window.innerWidth, window.innerHeight);
                        document.body.appendChild(renderer.domElement);
                        
                        const controls = new OrbitControls(camera, renderer.domElement);
                        controls.enableDamping = true;
                        
                        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
                        scene.add(ambientLight);
                        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
                        dirLight.position.set(10, 20, 10);
                        scene.add(dirLight);

                        const loader = new GLTFLoader();
                        const fontLoader = new FontLoader();
                        
                        const bumps = ${JSON.stringify(allBumps)};
                        const badIds = new Set(${JSON.stringify([...badIds])});
                        
                        const centerX = ${centerX};
                        const centerY = ${centerY};
                        const centerZ = ${centerZ};
                        const posScale = ${posScale};

                        const goodBumpGroups = [];
                        const badBumpGroups = [];

                        let isColorCoded = false;
                        
                        // Load font for labels
                        fontLoader.load('https://unpkg.com/three@0.154.0/examples/fonts/helvetiker_regular.typeface.json', (font) => {
                            
                            bumps.forEach((bump, index) => {
                                const apiUrl = \`/api/bump_model/${sampleId}/\${bump.id}?tag=${tag || ''}\`;
                                
                                fetch(apiUrl)
                                    .then(res => res.json())
                                    .then(data => {
                                        if (!data.url) return;
                                        
                                        bump.gltfUrl = data.url; // Cache URL for the details panel
                                        
                                        let x = 0, y = 0, z = 0;
                                        const explodeFactor = 2.5; // Increases grid spacing to prevent congestion
                                        if (bump.position) {
                                            x = (bump.position.x - centerX) * posScale * explodeFactor;
                                            y = (bump.position.z - centerZ) * posScale * explodeFactor; // Voxel Z mapped to Three Y
                                            z = -(bump.position.y - centerY) * posScale * explodeFactor; // Voxel Y mapped to Three -Z
                                        }
                                        
                                        loader.load(data.url, (gltf) => {
                                            const model = gltf.scene;
                                            
                                            // Calculate bounding box to normalize size and position
                                            const box = new THREE.Box3().setFromObject(model);
                                            const size = new THREE.Vector3();
                                            box.getSize(size);
                                            const center = new THREE.Vector3();
                                            box.getCenter(center);
                                            
                                            const maxDim = Math.max(size.x, size.y, size.z) || 1;
                                            
                                            // Scale and center geometry to match actual physical spacing
                                            model.scale.set(posScale, posScale, posScale);
                                            model.position.copy(center).multiplyScalar(-posScale);
                                            
                                            const group = new THREE.Group();
                                            group.add(model);
                                            
                                            const isBad = badIds.has(bump.id);
                                            group.userData = { id: bump.id, isBad: isBad };
                                            group.position.set(x, y, z);
                                            
                                            // Cache original colors and apply initial state
                                            model.traverse((child) => {
                                                if (child.isMesh && child.material) {
                                                    child.material = child.material.clone();
                                                    if (child.material.color) {
                                                        child.userData.originalColor = child.material.color.clone();
                                                        if (!isColorCoded) child.material.color.setHex(0x888888);
                                                    }
                                                }
                                            });

                                            const scaledMaxDim = maxDim * posScale || 4.0;
                                            const ringRadius = scaledMaxDim * 0.6;

                                            // Status Ring
                                            const color = isBad ? 0xef4444 : 0x4ade80;
                                            const ringGeo = new THREE.RingGeometry(ringRadius, ringRadius * 1.1, 32);
                                            const ringMat = new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide });
                                            const ring = new THREE.Mesh(ringGeo, ringMat);
                                            ring.rotation.x = -Math.PI / 2;
                                            ring.name = 'statusRing';
                                            ring.visible = isColorCoded;
                                            group.add(ring);

                                            // Text Label
                                            const labelText = bump.label.replace('Bump ', ''); // Turns "Bump 12 (Void)" into "12 (Void)"
                                            const textScale = scaledMaxDim * 0.15;
                                            const textGeo = new TextGeometry(labelText, {
                                                font: font,
                                                size: textScale,
                                                height: textScale * 0.2,
                                            });
                                            textGeo.computeBoundingBox();
                                            const textWidth = textGeo.boundingBox.max.x - textGeo.boundingBox.min.x;
                                            const textMat = new THREE.MeshBasicMaterial({ color: isBad ? 0xffcccc : 0xffffff });
                                            const textMesh = new THREE.Mesh(textGeo, textMat);
                                            textMesh.position.set(-textWidth / 2, scaledMaxDim * 0.7, 0); // Position above bump
                                            textMesh.name = 'statusText';
                                            textMesh.visible = isColorCoded;
                                            
                                            group.add(textMesh);
                                            
                                            if (isBad) {
                                                badBumpGroups.push(group);
                                            } else {
                                                goodBumpGroups.push(group);
                                            }
                                            scene.add(group);
                                        });
                                    })
                                    .catch(e => console.error("Error loading bump model:", e));
                            });
                        });

                        const toggleColorsBtn = document.getElementById('toggleColorsBtn');

                        if (toggleColorsBtn) {
                            toggleColorsBtn.addEventListener('click', () => {
                                isColorCoded = !isColorCoded;
                                toggleColorsBtn.innerText = isColorCoded ? 'View: Raw' : 'View: Analyzed';
                                toggleColorsBtn.style.background = isColorCoded ? '#64748b' : '#3b82f6';
                                
                                const updateGroup = (group) => {
                                    const ring = group.getObjectByName('statusRing');
                                    const textMesh = group.getObjectByName('statusText');
                                    if (ring) ring.visible = isColorCoded;
                                    if (textMesh) textMesh.visible = isColorCoded;
                                    
                                    group.traverse((child) => {
                                        if (child.isMesh && child.name !== 'statusRing' && child.name !== 'statusText' && child.material && child.material.color) {
                                            if (isColorCoded && child.userData.originalColor) {
                                                child.material.color.copy(child.userData.originalColor);
                                            } else if (!isColorCoded) {
                                                child.material.color.setHex(0x888888);
                                            }
                                        }
                                    });
                                };
                                goodBumpGroups.forEach(updateGroup);
                                badBumpGroups.forEach(updateGroup);
                            });
                        }

                        let goodBumpsVisible = true;
                        const toggleBtn = document.getElementById('toggleGoodBumpsBtn');

                        if (toggleBtn) {
                            toggleBtn.addEventListener('click', () => {
                                goodBumpsVisible = !goodBumpsVisible;
                                goodBumpGroups.forEach(group => {
                                    group.visible = goodBumpsVisible;
                                });
                                toggleBtn.innerText = goodBumpsVisible ? 'Hide Good Bumps' : 'Show Good Bumps';
                            });
                        }

                        let badBumpsVisible = true;
                        const toggleBadBtn = document.getElementById('toggleBadBumpsBtn');

                        if (toggleBadBtn) {
                            toggleBadBtn.addEventListener('click', () => {
                                badBumpsVisible = !badBumpsVisible;
                                badBumpGroups.forEach(group => {
                                    group.visible = badBumpsVisible;
                                });
                                toggleBadBtn.innerText = badBumpsVisible ? 'Hide Defective Bumps' : 'Show Defective Bumps';
                            });
                        }

                        const opacitySlider = document.getElementById('solderOpacitySlider');
                        const opacityVal = document.getElementById('solderOpacityVal');

                        const hiddenLayers = new Set();
                        
                        function updateMaterialVisibility() {
                            const solderOpacity = opacitySlider ? parseFloat(opacitySlider.value) : 1.0;
                            
                            scene.traverse((child) => {
                                if (child.isMesh && child.material && child.userData && child.userData.originalColor) {
                                    const orig = child.userData.originalColor;
                                    let type = null;
                                    
                                    // Detect layer type from original RGB values
                                    if (orig.r > 0.8 && orig.g < 0.2 && orig.b < 0.2) type = 'red';
                                    else if (orig.g > 0.4 && orig.r < 0.2 && orig.b < 0.2) type = 'green';
                                    else if (orig.b > 0.8 && orig.r < 0.2 && orig.g < 0.2) type = 'blue';
                                    else if (orig.r > 0.8 && orig.g > 0.8 && orig.b < 0.2) type = 'yellow';
                                    
                                    if (type) {
                                        let targetOpacity = hiddenLayers.has(type) ? 0.0 : 1.0;
                                        if (type === 'green' && !hiddenLayers.has('green')) {
                                            targetOpacity = solderOpacity;
                                        }
                                        
                                        child.visible = targetOpacity > 0;
                                        child.material.opacity = targetOpacity;
                                        child.material.transparent = targetOpacity < 1.0;
                                        child.material.needsUpdate = true;
                                    }
                                }
                            });
                        }

                        if (opacitySlider) {
                            opacitySlider.addEventListener('input', (e) => {
                                if (opacityVal) opacityVal.innerText = Math.round(parseFloat(e.target.value) * 100) + '%';
                                updateMaterialVisibility();
                            });
                        }

                        document.querySelectorAll('.legend-badge').forEach(badge => {
                            badge.addEventListener('click', (e) => {
                                const color = e.target.dataset.color;
                                const isHidden = hiddenLayers.has(color);
                                
                                if (isHidden) {
                                    hiddenLayers.delete(color);
                                    e.target.style.opacity = '1';
                                    e.target.style.textDecoration = 'none';
                                } else {
                                    hiddenLayers.add(color);
                                    e.target.style.opacity = '0.4';
                                    e.target.style.textDecoration = 'line-through';
                                }
                                
                                updateMaterialVisibility();
                            });
                        });

                        const searchInput = document.getElementById('searchBumpId');
                        const searchBtn = document.getElementById('searchBtn');

                        let isCameraAnimating = false;
                        const targetCameraPos = new THREE.Vector3();
                        const targetControlsPos = new THREE.Vector3();

                        function focusOnBump(searchValue) {
                            if (!searchValue) return;
                            
                            // Clean search value to handle inputs like "Bump 12" or just "12"
                            const cleanId = searchValue.replace(/[^0-9]/g, '');
                            const bumpId = cleanId || searchValue;

                            let targetGroup = null;
                            
                            scene.traverse((child) => {
                                if (child.isGroup && child.userData && String(child.userData.id) === String(bumpId)) {
                                    targetGroup = child;
                                }
                            });
                            
                            if (targetGroup) {
                                if (!targetGroup.visible) {
                                    alert("This bump is currently hidden by filters.");
                                    return;
                                }

                                const targetPos = targetGroup.position;
                                
                                // Set targets for smooth camera animation
                                targetCameraPos.set(targetPos.x, targetPos.y + 15, targetPos.z + 15);
                                targetControlsPos.copy(targetPos);
                                isCameraAnimating = true;
                                
                                // Defer the heavy DOM update so the camera animation starts smoothly without blocking the main thread
                                setTimeout(() => {
                                    showBumpDetails(bumpId);
                                }, 150);
                                
                                // Visual pop effect
                                const origScale = targetGroup.scale.clone();
                                targetGroup.scale.set(origScale.x * 1.5, origScale.y * 1.5, origScale.z * 1.5);
                                setTimeout(() => {
                                    if(targetGroup) targetGroup.scale.copy(origScale);
                                }, 500);

                            } else {
                                alert("Bump ID not found.");
                            }
                        }

                        if (searchBtn && searchInput) {
                            searchBtn.addEventListener('click', () => focusOnBump(searchInput.value.trim()));
                            searchInput.addEventListener('keydown', (e) => {
                                if (e.key === 'Enter') focusOnBump(searchInput.value.trim());
                            });
                        }

                        const exportBtn = document.getElementById('exportImageBtn');
                        if (exportBtn) {
                            exportBtn.addEventListener('click', () => {
                                const dataURL = renderer.domElement.toDataURL('image/png');
                                const link = document.createElement('a');
                                link.href = dataURL;
                                link.download = "${sampleId}_bump_grid.png";
                                link.click();
                            });
                        }

                        const raycaster = new THREE.Raycaster();
                        const mouse = new THREE.Vector2();
                        
                        const detailsPanel = document.getElementById('bumpDetailsPanel');
                        const detailsTitle = document.getElementById('bumpDetailsTitle');
                        const detailsContent = document.getElementById('bumpDetailsContent');
                        const closeBtn = document.getElementById('closeDetailsBtn');
                        
                        if (closeBtn) {
                            closeBtn.addEventListener('click', () => {
                                detailsPanel.style.display = 'none';
                            });
                        }
                        
                        window.setMiniSolderOpacity = function(val) {
                            const viewer = document.getElementById('miniModelViewer');
                            if (!viewer || !viewer.model) return;
                            const opacity = parseFloat(val);
                            const valSpan = document.getElementById('miniSolderOpacityVal');
                            if (valSpan) valSpan.innerText = Math.round(opacity * 100) + '%';
                            
                            for (const material of viewer.model.materials) {
                                const pbr = material.pbrMetallicRoughness;
                                const c = pbr.baseColorFactor;
                                const isSolder = (c[1] > 0.4 && c[0] < 0.2 && c[2] < 0.2);
                                if (isSolder) {
                                    pbr.setBaseColorFactor([c[0], c[1], c[2], opacity]);
                                    material.setAlphaMode(opacity < 1.0 ? 'BLEND' : 'OPAQUE');
                                }
                            }
                        };
                        
                        function showBumpDetails(bumpId) {
                            const bump = bumps.find(b => String(b.id) === String(bumpId));
                            if (!bump) return;
                            
                            const isBad = badIds.has(bump.id);
                            detailsTitle.innerText = bump.label;
                            detailsTitle.style.color = isBad ? '#ef4444' : '#4ade80';
                            
                            const viewerContainer = document.getElementById('miniViewerContainer');
                            const viewer = document.getElementById('miniModelViewer');
                            
                            if (bump.gltfUrl) {
                                viewerContainer.style.display = 'block';
                                if (viewer.src !== bump.gltfUrl) {
                                    viewer.src = bump.gltfUrl;
                                    // Reset slider for new bump
                                    document.getElementById('miniSolderSlider').value = 1;
                                    document.getElementById('miniSolderOpacityVal').innerText = '100%';
                                }
                            } else {
                                viewerContainer.style.display = 'none';
                            }
                            
                            let html = '';
                            
                            html += '<table style="width: 100%; border-collapse: collapse;">';
                            if (bump.metrics) {
                                const m = bump.metrics;
                                html += '<tr><td style="padding: 3px 0; color: #cbd5e1;">BLT:</td><td style="text-align: right; font-weight: bold;">' + m['BLT'].toFixed(2) + ' µm</td></tr>';
                                html += '<tr><td style="padding: 3px 0; color: #cbd5e1;">Void to Solder Ratio:</td><td style="text-align: right; font-weight: bold;">' + (m['Void Ratio'] * 100).toFixed(2) + ' %</td></tr>';
                                html += '<tr><td style="padding: 3px 0; color: #cbd5e1;">Pad Misalign:</td><td style="text-align: right; font-weight: bold;">' + m['Pad Misalignment'].toFixed(2) + ' µm</td></tr>';
                                html += '<tr><td style="padding: 3px 0; color: #cbd5e1;">Pillar Width:</td><td style="text-align: right; font-weight: bold;">' + m['Pillar Width'].toFixed(2) + ' µm</td></tr>';
                                html += '<tr><td style="padding: 3px 0; color: #cbd5e1;">Pillar Height:</td><td style="text-align: right; font-weight: bold;">' + m['Pillar Height'].toFixed(2) + ' µm</td></tr>';
                            } else {
                                html += '<tr><td style="color: #94a3b8; padding: 4px 0;">No metrology data available</td></tr>';
                            }
                            
                            if (bump.defects && bump.defects.length > 0) {
                                html += '<tr><td colspan="2" style="padding-top: 8px; color: #ef4444; font-weight: bold; font-size: 11px;">Defects: ' + bump.defects.join(', ') + '</td></tr>';
                            }
                            
                            html += '</table>';
                            document.getElementById('miniMetricsContainer').innerHTML = html;
                            detailsPanel.style.display = 'block';
                        }

                        window.addEventListener('click', (event) => {
                            if (event.target.tagName !== 'CANVAS') return;
                            
                            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
                            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
                            
                            raycaster.setFromCamera(mouse, camera);
                            
                            const activeGroups = [];
                            goodBumpGroups.forEach(g => { if (g.visible) activeGroups.push(g); });
                            badBumpGroups.forEach(g => { if (g.visible) activeGroups.push(g); });
                            
                            const intersects = raycaster.intersectObjects(activeGroups, true);
                            
                            if (intersects.length > 0) {
                                let object = intersects[0].object;
                                while (object && (!object.userData || object.userData.id === undefined)) {
                                    object = object.parent;
                                }
                                
                                if (object && object.userData && object.userData.id !== undefined) {
                                    const bumpId = object.userData.id;
                                    showBumpDetails(bumpId);
                                    focusOnBump(bumpId);
                                }
                            }
                        });

                        function animate() {
                            requestAnimationFrame(animate);
                            
                            // Smooth camera fly-over animation
                            if (isCameraAnimating) {
                                camera.position.lerp(targetCameraPos, 0.06);
                                controls.target.lerp(targetControlsPos, 0.06);
                                if (camera.position.distanceTo(targetCameraPos) < 0.1) {
                                    isCameraAnimating = false;
                                }
                            }
                            
                            controls.update();
                            renderer.render(scene, camera);
                        }
                        
                        window.addEventListener('resize', () => {
                            camera.aspect = window.innerWidth / window.innerHeight;
                            camera.updateProjectionMatrix();
                            renderer.setSize(window.innerWidth, window.innerHeight);
                        });

                        animate();
                    </script>
                </body></html>`);
            win.document.close();
        })
        .catch(e => {
            if(win) win.close();
            alert("Error viewing bumps: " + e.message);
        });
}
