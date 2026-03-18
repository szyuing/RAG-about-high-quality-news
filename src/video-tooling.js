function registerVideoTools(ToolRegistry, deps = {}) {
  const {
    transcribeVideo,
    downloadDouyinVideo,
    batchDownloadDouyinVideos,
    VIDEO_PROCESSING_CONFIG
  } = deps;

  if (typeof transcribeVideo !== "function") {
    throw new Error("registerVideoTools requires transcribeVideo");
  }
  if (typeof downloadDouyinVideo !== "function") {
    throw new Error("registerVideoTools requires downloadDouyinVideo");
  }
  if (typeof batchDownloadDouyinVideos !== "function") {
    throw new Error("registerVideoTools requires batchDownloadDouyinVideos");
  }
  if (!VIDEO_PROCESSING_CONFIG?.arsApi || !VIDEO_PROCESSING_CONFIG?.openSourceModel) {
    throw new Error("registerVideoTools requires VIDEO_PROCESSING_CONFIG");
  }

  ToolRegistry.registerTool({
    id: "transcribe_video",
    name: "Transcribe Video",
    description: "Convert video to text using ARS API or open-source model.",
    parameters: [
      {
        name: "videoUrl",
        type: "string",
        required: true,
        description: "Video URL to transcribe"
      },
      {
        name: "method",
        type: "string",
        required: false,
        description: "Transcription method: auto, ars_api, open_source_model",
        default: "auto"
      }
    ],
    validate(input) {
      if (!input?.videoUrl) {
        throw new Error("videoUrl is required");
      }
    },
    async execute(input) {
      const { videoUrl, method = "auto" } = input;

      const originalArsEnabled = VIDEO_PROCESSING_CONFIG.arsApi.enabled;
      const originalOpenSourceEnabled = VIDEO_PROCESSING_CONFIG.openSourceModel.enabled;

      try {
        if (method === "ars_api") {
          VIDEO_PROCESSING_CONFIG.arsApi.enabled = true;
          VIDEO_PROCESSING_CONFIG.openSourceModel.enabled = false;
        } else if (method === "open_source_model") {
          VIDEO_PROCESSING_CONFIG.arsApi.enabled = false;
          VIDEO_PROCESSING_CONFIG.openSourceModel.enabled = true;
        }

        return await transcribeVideo(videoUrl);
      } finally {
        VIDEO_PROCESSING_CONFIG.arsApi.enabled = originalArsEnabled;
        VIDEO_PROCESSING_CONFIG.openSourceModel.enabled = originalOpenSourceEnabled;
      }
    }
  });

  ToolRegistry.registerTool({
    id: "download_douyin_video",
    name: "Douyin Video Downloader",
    description: "Download Douyin videos without watermark when available.",
    parameters: [
      {
        name: "videoUrl",
        type: "string",
        required: true,
        description: "Douyin video URL"
      },
      {
        name: "outputDir",
        type: "string",
        required: false,
        description: "Download directory, defaults to ./downloads"
      },
      {
        name: "filename",
        type: "string",
        required: false,
        description: "Optional output file name"
      }
    ],
    async execute(input) {
      const { videoUrl, outputDir, filename } = input;
      if (!videoUrl) {
        throw new Error("Missing required parameter: videoUrl");
      }
      const result = await downloadDouyinVideo(videoUrl, {
        outputDir,
        filename
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    source: "builtin",
    status: "active"
  });

  ToolRegistry.registerTool({
    id: "batch_download_douyin_videos",
    name: "Batch Douyin Video Downloader",
    description: "Batch download Douyin videos with concurrency and delay control.",
    parameters: [
      {
        name: "videoUrls",
        type: "array",
        required: true,
        description: "Array of Douyin video URLs"
      },
      {
        name: "outputDir",
        type: "string",
        required: false,
        description: "Download directory, defaults to ./downloads"
      },
      {
        name: "concurrency",
        type: "number",
        required: false,
        description: "Concurrent workers, default is 2"
      },
      {
        name: "delay",
        type: "number",
        required: false,
        description: "Delay in milliseconds between requests"
      }
    ],
    async execute(input) {
      const { videoUrls, outputDir, concurrency, delay } = input;
      if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0) {
        throw new Error("Missing required parameter: videoUrls (must be a non-empty array)");
      }
      const result = await batchDownloadDouyinVideos(videoUrls, {
        outputDir,
        concurrency,
        delay
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    source: "builtin",
    status: "active"
  });
}

module.exports = {
  registerVideoTools
};
