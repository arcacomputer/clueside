/**
 * Immutable build inputs for the two bundled ONNX backbones.
 * Revisions and hashes come from the upstream Hugging Face repositories.
 */

export const MODEL_SPECS = [
  {
    repo: 'buildborderless/CommunityForensics-DeepfakeDet-ViT',
    revision: 'ac6ee457bea904a373065754107451793b56db00',
    dtype: 'fp32',
    onnx: 'onnx/model.onnx',
    inputSize: 384,
    files: [
      {
        path: 'onnx/model.onnx',
        bytes: 87_442_080,
        sha256: 'a42c7d740fbb345ba9a26d469b22f301d73089ce3c6da993877ed2b6965a8ba1',
      },
      {
        path: 'preprocessor_config.json',
        bytes: 306,
        sha256: 'd5e70eaba99880a52978157cf4e6ee71502fed9479dd7b659854107e131ee8f6',
      },
      {
        path: 'config.json',
        bytes: 524,
        sha256: '4b425d089842fecf8f25fc52aa44d09f49607ef89a0e2ff685ced6ec1c70e9b1',
      },
    ],
  },
  {
    repo: 'Xenova/dinov2-small',
    revision: 'c2bb04a51fab207c420665f1946016107bffc701',
    dtype: 'fp32',
    onnx: 'onnx/model.onnx',
    inputSize: 224,
    files: [
      {
        path: 'onnx/model.onnx',
        bytes: 88_459_888,
        sha256: '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea',
      },
      {
        path: 'preprocessor_config.json',
        bytes: 436,
        sha256: '14e780d86fa1861f8751f868d7f45425b5feb55c38ca26f152ca5097ab30f828',
      },
      {
        path: 'config.json',
        bytes: 899,
        sha256: '471007e1c59df520030a2690998f4e0ba5d810bc4f959d1984f630d198faa07e',
      },
    ],
  },
];

export function modelFileUrl(model, file) {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;
}

export function buildModelManifest(model) {
  return {
    id: model.repo,
    revision: model.revision,
    dtype: model.dtype,
    onnx: model.onnx,
    inputSize: model.inputSize,
    files: model.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
}
