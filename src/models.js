export const SOURCE_MODEL_ID = 'onnx-community/ai-source-detector-ONNX';
export const BINARY_MODEL_ID = 'onnx-community/ai-image-detection-ONNX';

export const MODEL_FILES = {
  [SOURCE_MODEL_ID]: ['onnx/model_quantized.onnx', 'config.json', 'preprocessor_config.json'],
  [BINARY_MODEL_ID]: ['onnx/model_quantized.onnx', 'config.json', 'preprocessor_config.json'],
};
