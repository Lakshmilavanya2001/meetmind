# Riva 25.12 runtime for the offline Parakeet model: the Whisper NIM image (used only as the runtime)
# plus the packages NeMo imports when Riva loads Parakeet's Python model (logging, kaldialign), from
# public PyPI (the image's pip is configured for an NVIDIA-internal index).
FROM nvcr.io/nim/nvidia/whisper-large-v3:1.5.1
USER root
RUN pip install --no-cache-dir --index-url https://pypi.org/simple \
      nv-one-logger-core nv-one-logger-training-telemetry nv-one-logger-pytorch-lightning-integration kaldialign
# NeMo's TensorRT encoder path imports the CUDA runtime as `cuda.cudart` (cuda-python 12 layout); this
# image has cuda-python 13, where the same API is `cuda.bindings.runtime`. Give it the old name.
RUN printf '# cuda-python 12 name for cuda.bindings.runtime, which NeMo imports\nfrom cuda.bindings.runtime import *  # noqa: F401,F403\n' \
      > /usr/local/lib/python3.12/dist-packages/cuda/cudart.py \
 && python3 -c "from cuda import cudart; cudart.cudaStreamSynchronize"
USER 1000
