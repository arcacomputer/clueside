export const PRIMARY_MODEL_ID = 'onnx-community/ai-image-detect-distilled-ONNX';
export const HINTS_MODEL_ID = 'onnx-community/ai-source-detector-ONNX';

export const MODEL_FILES = {
  [PRIMARY_MODEL_ID]: ['onnx/model_quantized.onnx', 'config.json', 'preprocessor_config.json'],
  [HINTS_MODEL_ID]: ['onnx/model_quantized.onnx', 'config.json', 'preprocessor_config.json'],
};
