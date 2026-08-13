export const MODEL_ID = 'buildborderless/CommunityForensics-DeepfakeDet-ViT';
export const MODEL_ONNX_PATH = 'onnx/model.onnx';
export const PREPROCESSOR_CONFIG_PATH = 'preprocessor_config.json';

export const MODEL_FILES = [MODEL_ONNX_PATH, PREPROCESSOR_CONFIG_PATH, 'config.json'];

export const SHORTEST_EDGE = 440;
export const CROP_SIZE = 384;

export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

export const ONNX_INPUT_NAME = 'pixel_values';
export const ONNX_OUTPUT_NAME = 'logits';
