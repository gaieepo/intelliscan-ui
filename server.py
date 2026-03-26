"""
Created on Wed 04 Feb 2026 10:30:09 AM
Author: Shubham Jariwala

3D-IntelliScan Backend Server

This module runs a FastAPI server that acts as the primary interface between 
the frontend dashboard and the backend 3D processing pipeline.

Key Responsibilities:
- Handling NIfTI file uploads.
- Triggering asynchronous analysis jobs (detection, segmentation, metrology) via main.py.
- Serving status updates, metrology statistics, and bump-level defect data to the UI.
- Dynamically generating and serving 3D GLTF models for browser visualization.
- Serving the frontend static files, templates, and generated PDF reports.
"""

import os
import shutil
from pathlib import Path
import subprocess
import sys

# Set matplotlib backend to Agg (non-interactive) to prevent GUI errors in threads
import matplotlib
matplotlib.use("Agg")

import uvicorn
from fastapi import FastAPI, File, UploadFile, BackgroundTasks, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import FileResponse
import numpy as np
import nibabel as nib
import pandas as pd
import ast
import json
import re
import time

from gltf_utils import generate_gltf_for_sample, generate_bump_gltf

try:
    import pyvista as pv
    try:
        pv.start_xvfb()
    except Exception:
        pass
except ImportError:
    pv = None

from utils import PipelineLogbook

# Configuration
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", 8001))
BASE_DIR = Path(__file__).parent.absolute()
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "output"
FRONTEND_DIR = BASE_DIR / "frontend_v3"

# Ensure directories exist
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="3D-IntelliScan Backend")

# Enable CORS (allows frontend to communicate if running on different port)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Helper Functions ---

def run_pipeline_task(file_path: Path, force: bool, tag: str | None):
    """Background task wrapper for the pipeline."""
    try:
        cmd = [
            sys.executable,
            str(BASE_DIR / "main.py"),
            str(file_path),
            "--output", str(OUTPUT_DIR),
        ]
        
        if force:
            cmd.append("--force")
        
        if tag:
            cmd.extend(["--tag", tag])

            # Dynamically resolve models based on the selected tag
            # Convention: models/<tag>_detection_model.pt and models/<tag>_segmentation_model.ckpt
            dynamic_det_model = BASE_DIR / "models" / f"{tag}_detection_model.pt"
            dynamic_seg_model = BASE_DIR / "models" / f"{tag}_segmentation_model.ckpt"
            
            cmd.extend(["--detection-model", str(dynamic_det_model)])
            cmd.extend(["--segmentation-model", str(dynamic_seg_model)])

        subprocess.run(cmd, check=True)

    except subprocess.CalledProcessError as e:
        print(f"Pipeline failed for {file_path}: {e}")
    except Exception as e:
        print(f"Pipeline failed for {file_path}: {e}")

def resolve_output_folder_name(sample_id: str, tag: str | None) -> str:
    """Constructs the output folder name from a sample ID and an optional tag."""
    # Try extracting SN number (e.g. SN002_3D_Feb24 -> SN002)
    match = re.match(r"(SN\d+)", sample_id)
    base_id = sample_id
    if match:
        base_id = match.group(1)
    
    # Construct folder name with tag
    return f"{base_id}_{tag}" if tag else base_id


def get_available_samples():
    """Get available samples from base directory."""
    samples = []
    
    # Exclude system/project folders
    exclude = {'.git', '.idea', '__pycache__', 'frontend_v3', 'output', 'uploads', 'models', 'static', 'templates', 'utils', 'venv', 'env', 'tools'}
    
    # Scan BASE_DIR for raw input folders
    if BASE_DIR.exists():
        for item in BASE_DIR.iterdir():
            if item.is_dir() and item.name not in exclude and not item.name.startswith('.'):
                # Check for NIfTI file
                nii_files = list(item.glob("*.nii")) + list(item.glob("*.nii.gz"))
                if len(nii_files) == 1:
                    # Found a valid raw sample folder
                    sample_id = item.name
                    filename = nii_files[0].name
                    
                    

                    samples.append({
                        "name": sample_id,
                        "filename": filename,
                    })
            
    return sorted(samples, key=lambda x: x["name"])

def get_available_models():
    """Get available model tags from the models directory."""
    tags = set()
    models_dir = BASE_DIR / "models"
    if models_dir.exists():
        for item in models_dir.iterdir():
            if item.is_file():
                match = re.match(r"(.+)_(?:detection_model\.pt|segmentation_model\.ckpt)$", item.name)
                if match:
                    tags.add(match.group(1))
    return sorted(list(tags))

# --- API Endpoints ---

@app.get("/api/health")
def health_check():
    return {"status": "online", "system": "3D-IntelliScan"}

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload a NIfTI file for processing."""
    if not file.filename.endswith(('.nii', '.nii.gz')):
        raise HTTPException(status_code=400, detail="Only .nii or .nii.gz files are supported")
    
    # Create a unique folder based on filename stem to act as Sample ID
    # e.g. uploads/sample_01/sample_01.nii.gz -> Output will be output/sample_01/
    file_stem = file.filename.split('.')[0]
    sample_dir = UPLOAD_DIR / file_stem
    sample_dir.mkdir(exist_ok=True)
    
    file_path = sample_dir / file.filename
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    return {"filename": file.filename, "sample_id": file_stem, "path": str(file_path)}

@app.post("/api/process/{sample_id}/{filename}")
async def process_scan(sample_id: str, filename: str, background_tasks: BackgroundTasks, force: bool = False, tag: str | None = None):
    """Trigger processing for an uploaded file."""
    file_path = UPLOAD_DIR / sample_id / filename
    
    if not file_path.exists():
        # Fallback to BASE_DIR for manually placed samples
        file_path = BASE_DIR / sample_id / filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    # Check logbook
    logbook = PipelineLogbook(OUTPUT_DIR)
    should_run, reason = logbook.should_process(file_path, force=force, tag=tag or "")
    
    if not should_run:
        return {"status": "skipped", "reason": reason, "job_id": str(file_path)}

    # Run pipeline in background (non-blocking)
    background_tasks.add_task(run_pipeline_task, file_path, force, tag)
    
    return {"status": "started", "job_id": str(file_path)}

@app.get("/api/jobs")
def list_jobs():
    """List all processing jobs and their status."""
    logbook = PipelineLogbook(OUTPUT_DIR)
    return logbook.list_jobs()

@app.get("/api/models")
def list_models():
    return {"models": get_available_models()}

@app.get("/api/status/{sample_id}")
def get_sample_status(sample_id: str, tag: str | None = None):
    """Check the processing status of a sample by inspecting output files."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    sample_dir = OUTPUT_DIR / folder_name
    
    status = {
        "conversion": "pending",
        "detection": "pending",
        "segmentation": "pending",
        "metrology": "pending",
        "completed": False,
        "data": {},
        "output_id": folder_name
    }
    
    if not sample_dir.exists():
        return status

    # 1. Check Conversion (Look for view1 images)
    view1_dir = sample_dir / "view1" / "input_images"
    if view1_dir.exists() and any(view1_dir.iterdir()):
        status["conversion"] = "completed"
        status["detection"] = "running"
        # Get a preview image
        images = list(view1_dir.glob("*.jpg"))
        if images:
            status["data"]["preview_image"] = f"/output/{folder_name}/view1/input_images/{images[len(images)//2].name}"

    # 2. Check Detection (bb3d.npy is generated after detection and merging)
    if (sample_dir / "bb3d.npy").exists():
        status["conversion"] = "completed"
        status["detection"] = "completed"
        status["segmentation"] = "running"

    # 3. Check if Metrology has started (by checking for its output folder).
    # This implies segmentation is complete and segmentation.nii.gz is saved.
    metrology_dir = sample_dir / "metrology"
    if metrology_dir.exists():
        status["detection"] = "completed"
        status["segmentation"] = "completed"
        status["metrology"] = "running"
        if (sample_dir / "segmentation.nii.gz").exists():
             status["data"]["segmentation_file"] = f"/output/{folder_name}/segmentation.nii.gz"

    # 4. Check if Metrology is finished (metrology.csv exists)
    if (metrology_dir / "metrology.csv").exists():
        status["segmentation"] = "completed" # Ensure this is set
        
        # Now check if the final GLTF model is ready
        if (sample_dir / "model.gltf").exists():
            status["metrology"] = "completed"
            status["completed"] = True
        else:
            # The pipeline is done, but the final model isn't ready yet.
            status["metrology"] = "finalizing"
            status["completed"] = False

    # 5. Get Durations from metrics.json
    metrics_path = sample_dir / "metrics.json"
    status["durations"] = {}
    if metrics_path.exists():
        try:
            with open(metrics_path) as f:
                m = json.load(f)
            
            phase_map = {
                "NII to JPG Conversion": "conversion",
                "2D Detection Inference": "detection",
                "3D Bounding Box Generation": "detection",
                "3D Segmentation": "segmentation",
                "3D Segmentation + Metrology": "segmentation",
                "Metrology": "metrology"
            }
            
            for p in m.get('phases', []):
                key = phase_map.get(p['name'])
                if key:
                    status["durations"][key] = status["durations"].get(key, 0.0) + p.get('duration', 0.0)
        except Exception as e:
            print(f"Error reading metrics for {sample_id}: {e}")

    return status

@app.get("/api/model/{sample_id}")
def get_3d_model(sample_id: str, tag: str | None = None):
    """Generate and return GLTF model for 3D visualization."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    try:
        generate_gltf_for_sample(folder_name, OUTPUT_DIR)
        return {"url": f"/output/{folder_name}/model.gltf"}
    except (EOFError, OSError):
        raise HTTPException(status_code=503, detail="Model file is being written")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Segmentation not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model generation failed: {str(e)}")

@app.get("/api/bumps/{sample_id}")
def get_bumps(sample_id: str, tag: str | None = None):
    """Get lists of good and bad bumps based on metrology results."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    csv_path = OUTPUT_DIR / folder_name / "metrology" / "metrology.csv"
    if not csv_path.exists():
        return {"good": [], "bad": []}
    
    # Retry logic for reading CSV (in case it's being written)
    df = None
    for i in range(5):
        try:
            df = pd.read_csv(csv_path)
            break
        except Exception:
            time.sleep(0.2)
            
    if df is None:
        print(f"Failed to read metrology CSV for {folder_name}")
        return {"good": [], "bad": []}

    good = []
    bad = []
    
    # Load affine for coordinate mapping
    nifti_path = OUTPUT_DIR / folder_name / "segmentation.nii.gz"
    affine = None
    
    if nifti_path.exists():
        try:
            img = nib.load(nifti_path)
            affine = img.affine
        except Exception as e:
            print(f"Error loading affine: {e}")
    
    for _, row in df.iterrows():
        # Extract ID from filename (e.g., "pred_12.nii.gz" -> "12")
        fname = str(row['filename'])
        fname = os.path.basename(fname)
        if not fname.startswith('pred_'): continue
        
        bump_id = fname.replace('pred_', '').replace('.nii.gz', '')
        
        defects = []
        if row.get('void_ratio_defect'): defects.append("Void")
        if row.get('solder_extrusion_defect'): defects.append("Extrusion")
        if row.get('pad_misalignment_defect'): defects.append("Misalignment")
        if row.get('pillar_aspect_ratio_defect'): defects.append("Aspect Ratio")
        
        def get_val(col):
            val = row.get(col)
            return float(val) if pd.notna(val) else 0.0

        item = {
            "id": bump_id,
            "label": f"Bump {bump_id}" + (f" ({', '.join(defects)})" if defects else ""),
            "defects": defects,
            "metrics": {
                "BLT": get_val('BLT'),
                "Void Ratio": get_val('Void_to_solder_ratio'),
                "Pad Misalignment": get_val('Pad_misalignment'),
                "Pillar Width": get_val('pillar_width'),
                "Pillar Height": get_val('pillar_height')
            }
        }
        
        # Calculate position from bounding box
        if 'bb' in row and affine is not None:
            try:
                bb_str = str(row['bb'])
                if bb_str.startswith('['):
                    bb = ast.literal_eval(bb_str)
                    # bb is [xmin, xmax, ymin, ymax, zmin, zmax]
                    cx = (bb[0] + bb[1]) / 2
                    cy = (bb[2] + bb[3]) / 2
                    # Use top of the bump (zmax) for better visibility
                    cz = bb[5]
                    
                    c_world = nib.affines.apply_affine(affine, np.array([[cx, cy, cz]]))[0]
                    
                    item['position'] = {'x': c_world[0], 'y': c_world[1], 'z': c_world[2]}
            except Exception:
                pass
        
        if defects:
            bad.append(item)
        else:
            good.append(item)
            
    return {"good": good, "bad": bad}

@app.get("/api/bump_model/{sample_id}/{bump_id}")
def get_bump_model(sample_id: str, bump_id: str, tag: str | None = None):
    """Generate and return GLTF model for a specific bump."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    try:
        url = generate_bump_gltf(folder_name, bump_id, OUTPUT_DIR)
        return {"url": url}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Bump segmentation not found")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Bump model generation failed: {str(e)}")

@app.get("/api/detection_preview/{sample_id}")
def get_detection_preview(sample_id: str, tag: str | None = None):
    """Get detection preview data (images + bboxes) for frontend visualization."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    sample_dir = OUTPUT_DIR / folder_name
    result = {}
    
    # View 1 (Horizontal) uses Class 0, View 2 (Vertical) uses Class 1
    for view_name, class_id in [("view1", 0), ("view2", 1)]:
        img_dir = sample_dir / view_name / "input_images"
        det_dir = sample_dir / view_name / "detections"
        
        if not img_dir.exists() or not det_dir.exists():
            print(f"DEBUG: Missing directories for {folder_name}/{view_name}. Img: {img_dir.exists()}, Det: {det_dir.exists()}")
            if sample_dir.exists():
                print(f"DEBUG: Contents of {sample_dir}: {[x.name for x in sample_dir.iterdir() if x.is_dir()]}")
            continue
            
        images = sorted(list(img_dir.glob("*.jpg")))
        if not images:
            print(f"DEBUG: No images found in {img_dir}")
            continue
            
        # Check if detection files exist
        det_files = list(det_dir.glob("*.txt"))
        if not det_files:
            print(f"DEBUG: Detection directory {det_dir} is empty! YOLO did not save any files.")
        else:
            print(f"DEBUG: Found {len(det_files)} detection files in {det_dir}. First file size: {det_files[0].stat().st_size} bytes")
            
        # Collect all images and their bboxes
        view_frames = []
        for img_path in images:
            txt_path = det_dir / f"{img_path.stem}.txt"
            bboxes = []
            
            if txt_path.exists() and txt_path.stat().st_size > 0:
                try:
                    # Load data: class_id x1 y1 x2 y2
                    data = np.loadtxt(str(txt_path))
                    if data.ndim == 1 and data.size > 0:
                        data = data.reshape(1, -1)

                    if data.size > 0:
                        for row in data:
                            bboxes.append({
                                "class_id": int(row[0]),
                                "x1": float(row[1]),
                                "y1": float(row[2]),
                                "x2": float(row[3]),
                                "y2": float(row[4])
                            })
                except Exception as e:
                    print(f"Error loading bboxes for {txt_path}: {e}")

            view_frames.append({
                "image_url": f"/output/{folder_name}/{view_name}/input_images/{img_path.name}",
                "bboxes": bboxes
            })

        result[view_name] = view_frames
        
    return result

@app.get("/api/metrology_stats/{sample_id}")
def get_metrology_stats(sample_id: str, tag: str | None = None):
    """Get statistical data for charts."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    csv_path = OUTPUT_DIR / folder_name / "metrology" / "metrology.csv"
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="Metrology data not found")
    
    try:
        df = pd.read_csv(csv_path)
        
        stats = {}
        
        # 1. Good vs Bad
        defect_cols = [c for c in df.columns if c.endswith("_defect")]
        if defect_cols:
            df["has_defect"] = df[defect_cols].any(axis=1)
            bad_count = int(df["has_defect"].sum())
            good_count = int(len(df) - bad_count)
        else:
            bad_count = 0
            good_count = len(df)
            
        stats["pie_data"] = [good_count, bad_count]
        
        # 2. Defect Types Breakdown
        defects = {}
        if "void_ratio_defect" in df.columns: defects["Void"] = int(df["void_ratio_defect"].sum())
        if "solder_extrusion_defect" in df.columns: defects["Extrusion"] = int(df["solder_extrusion_defect"].sum())
        if "pad_misalignment_defect" in df.columns: defects["Misalignment"] = int(df["pad_misalignment_defect"].sum())
        if "pillar_aspect_ratio_defect" in df.columns: defects["Aspect Ratio"] = int(df["pillar_aspect_ratio_defect"].sum())
        
        stats["defect_counts"] = defects

        # 3. BLT Distribution (Histogram)
        if "BLT" in df.columns:
            data = df["BLT"].dropna().values
            if len(data) > 0:
                hist, bin_edges = np.histogram(data, bins='auto')
                stats["blt_hist"] = {
                    "counts": hist.tolist(),
                    "labels": [f"{bin_edges[i]:.1f}-{bin_edges[i+1]:.0f}" for i in range(len(hist))]
                }
        
        # 4. Void Ratio Distribution
        if "Void_to_solder_ratio" in df.columns:
            data = df["Void_to_solder_ratio"].dropna().values
            if len(data) > 0:
                # Fixed bins: 2% steps up to 16%, then a catch-all for 16%+
                # Using -inf and inf ensures no outlier data is ever dropped from the chart
                fixed_bins = [-float('inf'), 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, float('inf')]
                hist, _ = np.histogram(data, bins=fixed_bins)
                stats["void_hist"] = {
                    "counts": hist.tolist(),
                    "labels": ["0-2%", "2-4%", "4-6%", "6-8%", "8-10%", "10-12%", "12-14%", "14-16%", "16%+"]
                }
        
        # 5. Summary Metrics for Comparison
        stats["summary"] = {
            "total_bumps": int(len(df)),
            "yield_rate": float((good_count / len(df) * 100) if len(df) > 0 else 0),
            "mean_blt": float(df["BLT"].mean()) if "BLT" in df.columns else 0.0,
            "mean_void": float(df["Void_to_solder_ratio"].mean()) if "Void_to_solder_ratio" in df.columns else 0.0
        }
                
        return stats
    except Exception as e:
        print(f"Error generating stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/report/{sample_id}")
def get_report(sample_id: str, tag: str | None = None):
    """Download the generated PDF report."""
    folder_name = resolve_output_folder_name(sample_id, tag)
    report_path = OUTPUT_DIR / folder_name / "metrology" / "metrology_report.pdf"
    
    if not report_path.exists():
        raise HTTPException(status_code=404, detail="Report not found")
        
    return FileResponse(report_path, media_type="application/pdf", filename=f"{folder_name}_report.pdf")

# --- Static File Serving ---

# 1. Serve Output Files (Images, CSVs)
# Frontend can access: /output/sample_id/metrology/metrology.csv
app.mount("/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")

# Serve static files (css, js, images)
app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")

# Setup templates
templates = Jinja2Templates(directory=str(FRONTEND_DIR / "templates"))

@app.get("/")
async def read_root(request: Request):
    """Serve the main pipeline page."""
    samples = get_available_samples()
    return templates.TemplateResponse("pipeline.html", {"request": request, "samples": samples})

@app.api_route("/pipeline", methods=["GET", "POST"])
async def handle_pipeline(request: Request):
    """Handle /pipeline route to support existing frontend forms."""
    samples = get_available_samples()
    return templates.TemplateResponse("pipeline.html", {"request": request, "samples": samples})

if __name__ == "__main__":
    print(f"Starting server at http://{HOST}:{PORT}")
    print(f"Frontend served from: {FRONTEND_DIR}")
    uvicorn.run("server:app", host=HOST, port=PORT, reload=True)
