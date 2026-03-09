/**
 * 3D-IntelliScan Frontend Logic
 * Handles file uploads, processing triggers, and status polling.
 */

// Global state
const pollIntervals = { left: null, right: null };
const currentSamples = { left: null, right: null };
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
    const option = select.options[select.selectedIndex];
    const sampleId = select.value;
    
    if (!sampleId) {
        alert("Please select a sample first.");
        return;
    }

    const filename = option.dataset.filename;
    const isCompleted = option.dataset.completed === 'true';
    
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
    
    // Trigger processing if not completed and filename is available
    if (!isCompleted && filename) {
        const statusDiv = document.getElementById(`${side}-statusMessage`);
        if (statusDiv) {
            statusDiv.innerText = "Starting analysis for existing sample...";
            statusDiv.className = "mt-4 text-center fw-medium text-primary";
        }
        try {
            await fetch(`/api/process/${sampleId}/${filename}?force=false`, { method: "POST" });
        } catch (e) {
            console.error("Error triggering process:", e);
        }
    }
    
    // Start polling immediately for the existing sample
    startPolling(side, null, sampleId);
}

/**
 * Poll the backend for job status.
 */
function startPolling(side, inputPath, sampleId) {
    currentSamples[side] = sampleId;
    const statusDiv = document.getElementById(`${side}-statusMessage`);
    const uploadBtn = document.getElementById(`${side}-uploadBtn`);
    
    if (pollIntervals[side]) clearInterval(pollIntervals[side]);

    pollIntervals[side] = setInterval(async () => {
        try {
            // Poll the granular status endpoint
            const response = await fetch(`/api/status/${sampleId}`);
            const status = await response.json();
            
            const effectiveId = status.output_id || sampleId;

            updatePhaseUI(side, 'conversion', status.conversion, status.data, effectiveId, status.durations?.conversion);
            updatePhaseUI(side, 'detection', status.detection, status.data, effectiveId, status.durations?.detection);
            updatePhaseUI(side, 'segmentation', status.segmentation, status.data, effectiveId, status.durations?.segmentation);
            updatePhaseUI(side, 'metrology', status.metrology, status.data, effectiveId, status.durations?.metrology);

            if (status.completed) {
                clearInterval(pollIntervals[side]);
                if (statusDiv) {
                    statusDiv.innerText = "Analysis Complete!";
                    statusDiv.className = "mt-4 text-center fw-bold text-success";
                }
                if (uploadBtn) uploadBtn.disabled = false;
                displayResults(side, effectiveId);
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
function loadBumpAnalysis(side, sampleId, card) {
    if (card.querySelector('.bump-analysis-section') || card.dataset.loadingBumps === 'true') return;
    
    card.dataset.loadingBumps = 'true';
    fetch(`/api/bumps/${sampleId}`)
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
                                <select class="form-select form-select-sm mb-2" onchange="window.loadBumpModel('${sampleId}', this, 'good-bump-viewer-${side}')">
                                    <option value="">Select a bump...</option>
                                    ${bumps.good.map(b => `<option value="${b.id}" data-pos='${JSON.stringify(b.position || null)}'>${b.label}</option>`).join('')}
                                </select>
                                <model-viewer id="good-bump-viewer-${side}" camera-controls auto-rotate style="width: 100%; height: 200px; background-color: #1e293b; border-radius: 6px;" shadow-intensity="1"></model-viewer>
                                ${window.getLayerControls(`good-bump-viewer-${side}`)}
                            </div>
                            <div class="col-md-6">
                                <label class="small fw-bold text-danger mb-1">Defective Bumps</label>
                                <select class="form-select form-select-sm mb-2" onchange="window.loadBumpModel('${sampleId}', this, 'bad-bump-viewer-${side}')">
                                    <option value="">Select a bump...</option>
                                    ${bumps.bad.map(b => `<option value="${b.id}" data-pos='${JSON.stringify(b.position || null)}'>${b.label}</option>`).join('')}
                                </select>
                                <model-viewer id="bad-bump-viewer-${side}" camera-controls auto-rotate style="width: 100%; height: 200px; background-color: #1e293b; border-radius: 6px;" shadow-intensity="1"></model-viewer>
                                ${window.getLayerControls(`bad-bump-viewer-${side}`)}
                            </div>
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
function updatePhaseUI(side, phase, status, data, sampleId, duration) {
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
                fetch(`/api/detection_preview/${sampleId}`)
                    .then(res => res.json())
                    .then(detData => {
                        console.log("Received detection preview data:", detData);
                        
                        detectionCache[sampleId] = detData;
                        
                        // Generate unique IDs for this side
                        const uniqueId = `${side}-${sampleId}`;
                        const imgId = `det-img-${uniqueId}`;
                        const canvasId = `det-canvas-${uniqueId}`;
                        const sliderId = `det-slider-${uniqueId}`;
                        const counterId = `det-counter-${uniqueId}`;
                        
                        // Determine available views
                        const hasView1 = detData.view1 && detData.view1.length > 0;
                        const hasView2 = detData.view2 && detData.view2.length > 0;
                        
                        // Set initial view
                        detectionState[side].view = hasView1 ? 'view1' : (hasView2 ? 'view2' : null);
                        detectionState[side].slice = 0;

                        if (hasView1 || hasView2) {
                            const currentView = detectionState[side].view;
                            const frames = detData[currentView];
                            const maxSlice = frames.length - 1;
                            
                            content.innerHTML = `
                                <div class="d-flex justify-content-between align-items-center mt-2 mb-1">
                                    <div class="d-flex align-items-center gap-2">
                                        <div class="btn-group btn-group-sm" role="group">
                                            ${hasView1 ? `<input type="radio" class="btn-check" name="view-switch-${uniqueId}" id="v1-${uniqueId}" autocomplete="off" checked onclick="window.setDetectionView('${side}', '${sampleId}', 'view1')"><label class="btn btn-outline-primary" for="v1-${uniqueId}">View 1</label>` : ''}
                                            ${hasView2 ? `<input type="radio" class="btn-check" name="view-switch-${uniqueId}" id="v2-${uniqueId}" autocomplete="off" ${!hasView1 ? 'checked' : ''} onclick="window.setDetectionView('${side}', '${sampleId}', 'view2')"><label class="btn btn-outline-primary" for="v2-${uniqueId}">View 2</label>` : ''}
                                        </div>
                                        <div class="form-check form-switch mb-0">
                                            <input class="form-check-input" type="checkbox" id="bbox-toggle-${uniqueId}" checked onchange="window.toggleBBoxes('${canvasId}', this)">
                                            <label class="form-check-label small" for="bbox-toggle-${uniqueId}">Boxes</label>
                                        </div>
                                    </div>
                                    <span class="badge bg-secondary" id="${counterId}">Slice: 1/${frames.length}</span>
                                </div>
                                <div class="detection-preview position-relative mt-2">
                                    <img id="${imgId}" class="img-fluid rounded border w-100" style="min-height: 200px; background: #000;">
                                    <canvas id="${canvasId}" class="position-absolute top-0 start-0 w-100 h-100" style="pointer-events: auto;"></canvas>
                                </div>
                                <div class="mt-2">
                                    <input type="range" class="form-range" id="${sliderId}" min="0" max="${maxSlice}" value="0" oninput="window.updateDetectionFrame('${side}', '${sampleId}', this.value)">
                                </div>`;
                                
                            // Initialize first frame
                            setTimeout(() => window.updateDetectionFrame(side, sampleId, 0), 100);
                        }
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
                    fetch(`/api/model/${sampleId}`)
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
                                loadBumpAnalysis(side, sampleId, card);
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
                loadBumpAnalysis(side, sampleId, card);
            }
        }

        // Special handling for metrology charts
        if (phase === 'metrology' && !card.querySelector('.metrology-charts')) {
            const content = card.querySelector('.phase-content');
            if (content) {
                window.renderMetrologyCharts(sampleId, content, side);
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
function displayResults(side, sampleId) {
    const resultsSection = document.getElementById(`${side}-resultsSection`);
    if (resultsSection) resultsSection.style.display = 'block';

    const downloadBtn = document.getElementById(`${side}-downloadReportBtn`);
    if (downloadBtn) {
        downloadBtn.onclick = () => window.open(`/api/report/${sampleId}`, '_blank');
    }
    
    const csvLink = document.getElementById(`${side}-csvLink`);
    if (csvLink) {
        csvLink.href = `/output/${sampleId}/metrology/metrology.csv`;
    }
}

/**
 * Update the detection frame based on slider input.
 */
window.updateDetectionFrame = function(side, sampleId, index) {
    const data = detectionCache[sampleId];
    if (!data) return;

    const view = detectionState[side].view;
    const frames = data[view];
    if (!frames || !frames[index]) return;

    const frame = frames[index];
    const uniqueId = `${side}-${sampleId}`;
    const img = document.getElementById(`det-img-${uniqueId}`);
    const canvasId = `det-canvas-${uniqueId}`;
    const counter = document.getElementById(`det-counter-${uniqueId}`);

    if (img) {
        img.src = frame.image_url;
        // Draw boxes once image loads
        img.onload = () => {
            window.drawDetectionBoxes(canvasId, img.id, frame.bboxes);
        };
    }
    
    if (counter) {
        counter.innerText = `Slice: ${parseInt(index) + 1}/${frames.length}`;
    }
    
    detectionState[side].slice = index;
}

/**
 * Switch detection view (View 1 / View 2).
 */
window.setDetectionView = function(side, sampleId, viewName) {
    detectionState[side].view = viewName;
    const uniqueId = `${side}-${sampleId}`;
    const slider = document.getElementById(`det-slider-${uniqueId}`);
    
    // Reset slider to 0 and update
    if (slider) slider.value = 0;
    window.updateDetectionFrame(side, sampleId, 0);
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
 * Toggle bounding box visibility.
 */
window.toggleBBoxes = function(canvasId, checkbox) {
    const canvas = document.getElementById(canvasId);
    if (canvas) {
        canvas.style.visibility = checkbox.checked ? 'visible' : 'hidden';
        if (!checkbox.checked) {
            const tooltip = document.getElementById('bbox-tooltip');
            if (tooltip) tooltip.style.display = 'none';
        }
    }
}

/**
 * Load a specific bump model into a viewer.
 */
window.loadBumpModel = function(sampleId, selectOrId, viewerId) {
    let bumpId = selectOrId;
    let position = null;
    
    if (typeof selectOrId === 'object') {
        bumpId = selectOrId.value;
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
    
    fetch(`/api/bump_model/${sampleId}/${bumpId}`)
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
window.renderMetrologyCharts = function(sampleId, container, side) {
    container.innerHTML = `
        <div class="metrology-charts row g-3 mt-2">
            <div class="col-md-6">
                <div class="p-2 border rounded bg-dark" style="height: 300px; position: relative;">
                    <canvas id="chart-pie-${side}"></canvas>
                </div>
            </div>
            <div class="col-md-6">
                <div class="p-2 border rounded bg-dark" style="height: 300px; position: relative;">
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

    fetch(`/api/metrology_stats/${sampleId}`)
        .then(res => res.json())
        .then(data => {
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
                    layout: { padding: { top: 20 } },
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
                    scales: { y: { ticks: { color: 'white' } }, x: { ticks: { color: 'white' } } }
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
                            title: { display: true, text: 'Void Ratio Distribution', color: 'white' }, 
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
    const leftId = currentSamples.left;
    const rightId = currentSamples.right;
    const section = document.getElementById('comparison-section');
    
    // Check if we are in single view mode (right column hidden)
    const colRight = document.getElementById('col-right');
    if (colRight && colRight.classList.contains('d-none')) {
        if(section) section.style.display = 'none';
        return;
    }
    
    if (!leftId || !rightId) {
        if(section) section.style.display = 'none';
        return;
    }

    try {
        const [leftRes, rightRes] = await Promise.all([
            fetch(`/api/metrology_stats/${leftId}`),
            fetch(`/api/metrology_stats/${rightId}`)
        ]);

        if (!leftRes.ok || !rightRes.ok) return;

        const leftStats = await leftRes.json();
        const rightStats = await rightRes.json();

        if(section) section.style.display = 'block';
        
        document.getElementById('comp-left-header').innerText = leftId;
        document.getElementById('comp-right-header').innerText = rightId;

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
    const leftId = currentSamples.left;
    const rightId = currentSamples.right;
    
    if (!leftId || !rightId) {
        alert("No comparison data available to export.");
        return;
    }

    const rows = [];
    
    // Headers
    rows.push(['Metric', `Left Sample (${leftId})`, `Right Sample (${rightId})`, 'Difference']);

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
    link.setAttribute("download", `comparison_${leftId}_vs_${rightId}.csv`);
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

// Expose to global scope for HTML onclick
window.handleUpload = handleUpload;
