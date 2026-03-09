import threading
import time
from pathlib import Path

import nibabel as nib
import numpy as np

try:
    import pyvista as pv
except ImportError:
    pv = None

# Lock for 3D model generation to prevent PyVista concurrency issues
model_generation_lock = threading.Lock()


def generate_gltf_for_sample(sample_id: str, output_base_dir: Path):
    """Helper to generate GLTF model from NIfTI."""
    sample_dir = output_base_dir / sample_id
    nifti_path = sample_dir / "segmentation.nii.gz"
    gltf_path = sample_dir / "model.gltf"

    if not nifti_path.exists():
        raise FileNotFoundError("Segmentation file not found")

    # Check cache
    if gltf_path.exists() and gltf_path.stat().st_mtime > nifti_path.stat().st_mtime:
        return

    if pv is None:
        raise ImportError("PyVista not installed")

    nifti_img = None
    last_exception = None
    data = None
    for i in range(5):
        try:
            nifti_img = nib.load(nifti_path)
            data = nifti_img.get_fdata()
            break
        except (EOFError, OSError) as e:
            last_exception = e
            time.sleep(1)

    if data is None or nifti_img is None:
        print(f"Failed to read NIfTI file after multiple retries: {last_exception}")
        raise last_exception

    affine = nifti_img.affine
    downsample_factor = 3
    data = data[::downsample_factor, ::downsample_factor, ::downsample_factor]
    affine_downsampled = np.copy(affine)
    affine_downsampled[:3, :3] *= downsample_factor
    dims = np.array(data.shape)
    origin = affine_downsampled[:3, 3]
    spacing = np.sqrt(np.sum(affine_downsampled[:3, :3] ** 2, axis=0))
    unique_classes = np.unique(np.round(data[data > 0.1])).astype(int)
    color_map = {1: "red", 2: "green", 3: "blue", 4: "yellow"}

    with model_generation_lock:
        if gltf_path.exists() and gltf_path.stat().st_mtime > nifti_path.stat().st_mtime:
            return

        pl = pv.Plotter(off_screen=True)
        has_mesh = False
        for cls in unique_classes:
            try:
                class_mask = (np.round(data) == cls).astype(float)
                grid = pv.ImageData(dimensions=dims, origin=origin, spacing=spacing)
                grid.point_data["values"] = class_mask.flatten(order="F")
                isosurface = grid.contour([0.5], scalars="values")
                if isosurface.n_points > 0:
                    if isosurface.n_points > 10000:
                        isosurface = isosurface.decimate(0.5)
                    color = color_map.get(int(cls), "white")
                    pl.add_mesh(isosurface, color=color, opacity=1.0, smooth_shading=True)
                    has_mesh = True
            except Exception as e:
                print(f"Error processing class {cls}: {e}")

        if has_mesh:
            pl.export_gltf(str(gltf_path))


def generate_bump_gltf(sample_id: str, bump_id: str, output_base_dir: Path) -> str:
    """Helper to generate GLTF model for a single bump."""
    sample_dir = output_base_dir / sample_id
    nifti_path = sample_dir / "mmt" / "pred" / f"pred_{bump_id}.nii.gz"
    gltf_path = sample_dir / "mmt" / "pred" / f"pred_{bump_id}.gltf"

    if not nifti_path.exists():
        raise FileNotFoundError(f"Bump segmentation not found: {nifti_path}")

    if gltf_path.exists() and gltf_path.stat().st_mtime > nifti_path.stat().st_mtime:
        return f"/output/{sample_id}/mmt/pred/pred_{bump_id}.gltf"

    if pv is None:
        raise ImportError("PyVista not installed")

    nifti_img, last_exception, data = None, None, None
    for i in range(5):
        try:
            nifti_img = nib.load(nifti_path)
            data = nifti_img.get_fdata()
            break
        except (EOFError, OSError) as e:
            last_exception = e
            time.sleep(0.5)

    if data is None:
        raise IOError(f"Could not read bump file: {last_exception}")

    affine = nifti_img.affine
    dims, origin, spacing = np.array(data.shape), affine[:3, 3], np.sqrt(np.sum(affine[:3, :3] ** 2, axis=0))
    unique_classes, color_map = np.unique(np.round(data[data > 0.1])).astype(int), {1: "red", 2: "green", 3: "blue", 4: "yellow"}

    try:
        with model_generation_lock:
            if gltf_path.exists() and gltf_path.stat().st_mtime > nifti_path.stat().st_mtime:
                return f"/output/{sample_id}/mmt/pred/pred_{bump_id}.gltf"

            pl, has_mesh = pv.Plotter(off_screen=True), False
            for cls in unique_classes:
                try:
                    class_mask = (np.round(data) == cls).astype(float)
                    grid = pv.ImageData(dimensions=dims, origin=origin, spacing=spacing)
                    grid.point_data["values"] = class_mask.flatten(order="F")
                    isosurface = grid.contour([0.5], scalars="values")
                    if isosurface.n_points > 0:
                        color = color_map.get(int(cls), "white")
                        pl.add_mesh(isosurface, color=color, opacity=1.0, smooth_shading=True)
                        has_mesh = True
                except Exception:
                    pass

            if has_mesh:
                pl.export_gltf(str(gltf_path))
            else:
                raise ValueError("No meshes generated for bump")

    except ValueError:
        raise ValueError("Bump model is empty")
    except Exception as e:
        print(f"Error generating bump GLTF {bump_id}: {e}")
        raise

    return f"/output/{sample_id}/mmt/pred/pred_{bump_id}.gltf"


def generate_all_bump_gltfs(sample_id: str, output_base_dir: Path) -> int:
    """Generate GLTF models for all bumps in the sample."""
    sample_dir = output_base_dir / sample_id
    pred_dir = sample_dir / "mmt" / "pred"
    if not pred_dir.exists():
        return 0

    files = list(pred_dir.glob("pred_*.nii.gz"))
    print(f"Generating GLTF models for {len(files)} bumps in {sample_id}...")

    for f in files:
        try:
            bump_id = f.name.replace("pred_", "").replace(".nii.gz", "")
            generate_bump_gltf(sample_id, bump_id, output_base_dir)
        except Exception as e:
            print(f"Error generating bump GLTF for {f.name}: {e}")

    return len(files)