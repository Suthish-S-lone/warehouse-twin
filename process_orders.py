"""
Convenience entry point for running the data processing pipeline.
"""
from pathlib import Path
import sys

# Add data-pipeline to sys.path
pipeline_dir = Path(__file__).resolve().parent / "data-pipeline"
if str(pipeline_dir) not in sys.path:
    sys.path.insert(0, str(pipeline_dir))

from process_orders import main

if __name__ == "__main__":
    main()
