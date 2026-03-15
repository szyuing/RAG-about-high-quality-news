const sources = [
  {
    id: "sora-official-update",
    title: "Sora product update snapshot",
    url: "https://demo.local/openai/sora-update",
    platform: "OpenAI",
    sourceType: "web",
    author: "OpenAI Product Team",
    publishedAt: "2025-01-10",
    duration: null,
    engagement: 9800,
    authorityScore: 0.97,
    summary: "Product snapshot describing Sora access, generation duration, storyboard, remix and recut workflows.",
    tags: ["sora", "openai", "video generation", "duration", "storyboard", "remix", "recut"],
    content: {
      markdown: [
        "# Sora product update snapshot",
        "",
        "Sora currently supports generation up to 20 seconds per clip in the consumer-facing workflow.",
        "The updated workflow adds storyboard sequencing, remix, blend and recut tools for iterative editing.",
        "The product team positions these controls as the bridge from one-shot generation to editor-like iteration."
      ].join("\n"),
      keyPoints: [
        "Current clip limit in this snapshot is 20 seconds.",
        "Storyboard enables shot planning across multiple segments.",
        "Remix and recut shift the product toward editable generation instead of single-pass prompts."
      ],
      sections: [
        { heading: "Duration", excerpt: "Supports generation up to 20 seconds per clip." },
        { heading: "Editing", excerpt: "Storyboard, remix, blend and recut are now part of the workflow." }
      ]
    },
    facts: [
      { subject: "sora", kind: "duration_limit_seconds", claim: "Current generation limit is 20 seconds", value: 20, unit: "seconds", evidence: "Supports generation up to 20 seconds per clip." },
      { subject: "sora", kind: "architecture_update", claim: "Adds storyboard sequencing", value: "storyboard", evidence: "Storyboard sequencing is part of the updated workflow." },
      { subject: "sora", kind: "architecture_update", claim: "Adds remix and recut tools", value: "remix_recut", evidence: "Remix and recut are now part of the workflow." }
    ]
  },
  {
    id: "sora-launch-report",
    title: "Sora launch report snapshot",
    url: "https://demo.local/openai/sora-launch",
    platform: "OpenAI",
    sourceType: "document",
    author: "OpenAI Research",
    publishedAt: "2024-02-15",
    duration: null,
    engagement: 8600,
    authorityScore: 0.96,
    summary: "Launch-era description of Sora capabilities focused on long-form coherence and text-to-video generation.",
    tags: ["sora", "launch", "openai", "video generation", "research"],
    content: {
      markdown: [
        "# Sora launch report snapshot",
        "",
        "At launch, the system highlighted the ability to generate videos up to 60 seconds while preserving scene consistency.",
        "The architecture emphasis was world simulation, long-range coherence and prompt following.",
        "Editing-oriented controls were not the center of the launch narrative."
      ].join("\n"),
      keyPoints: [
        "Launch materials highlighted up to 60 seconds generation.",
        "Initial positioning focused on coherence and simulation.",
        "Editing controls were less prominent at launch."
      ],
      sections: [
        { heading: "Capability", excerpt: "Generate videos up to 60 seconds." },
        { heading: "Model focus", excerpt: "World simulation and long-range coherence." }
      ]
    },
    facts: [
      { subject: "sora", kind: "launch_duration_seconds", claim: "Launch materials highlighted 60 seconds", value: 60, unit: "seconds", evidence: "Generate videos up to 60 seconds." },
      { subject: "sora", kind: "architecture_focus", claim: "Launch focus was world simulation", value: "world_simulation", evidence: "The architecture emphasis was world simulation and long-range coherence." }
    ]
  },
  {
    id: "sora-video-analysis",
    title: "Sora update breakdown video",
    url: "https://demo.local/video/sora-breakdown",
    platform: "YouTube",
    sourceType: "video",
    author: "AI Product Lab",
    publishedAt: "2025-01-14",
    duration: "18:24",
    engagement: 410000,
    authorityScore: 0.78,
    summary: "Video analysis comparing launch-era Sora messaging with the latest product workflow and editing stack.",
    tags: ["sora", "youtube", "analysis", "storyboard", "workflow", "duration"],
    transcript: [
      { start: "00:00", text: "The practical headline is that the current product flow caps clips at twenty seconds." },
      { start: "04:42", text: "What changed most is not raw duration but controllability through storyboard, remix and recut." },
      { start: "09:10", text: "The launch story was simulation and coherence; the update story is editing and iteration." },
      { start: "14:05", text: "This means the system behaves more like a video workspace than a single prompt demo." }
    ],
    timeline: [
      { start: "00:00", title: "Current clip limit", summary: "States the practical cap is 20 seconds in the current flow." },
      { start: "04:42", title: "Editing stack", summary: "Explains storyboard, remix and recut as the main product shift." },
      { start: "09:10", title: "Launch vs current", summary: "Contrasts simulation-centric launch framing with editing-centric update framing." }
    ],
    keyFrames: [
      "Slide comparing launch-era and current Sora product messaging",
      "Storyboard editor UI mockup",
      "Timeline showing remix and recut flow"
    ],
    facts: [
      { subject: "sora", kind: "duration_limit_seconds", claim: "Current practical limit is 20 seconds", value: 20, unit: "seconds", evidence: "The practical headline is that the current product flow caps clips at twenty seconds." },
      { subject: "sora", kind: "architecture_update", claim: "Major shift is toward editing and iteration", value: "editing_iteration", evidence: "What changed most is controllability through storyboard, remix and recut." }
    ]
  },
  {
    id: "sora-forum-thread",
    title: "Community thread on Sora rollout",
    url: "https://demo.local/forum/sora-thread",
    platform: "Forum",
    sourceType: "forum",
    author: "productwatcher88",
    publishedAt: "2025-01-16",
    duration: null,
    engagement: 1200,
    authorityScore: 0.38,
    summary: "Forum discussion where users debate whether current limits are 20 or 30 seconds and discuss editing controls.",
    tags: ["sora", "forum", "duration", "community"],
    content: {
      markdown: [
        "# Community thread on Sora rollout",
        "",
        "Several users report seeing a 20 second limit while some mention 30 seconds in beta accounts.",
        "Participants agree the more notable change is the editing workflow rather than raw generation length."
      ].join("\n"),
      keyPoints: [
        "Community reports conflict on 20 vs 30 second limits.",
        "Editing workflow is widely seen as the bigger upgrade."
      ],
      sections: [
        { heading: "Reports", excerpt: "Users report both 20 and 30 second limits." }
      ]
    },
    facts: [
      { subject: "sora", kind: "duration_limit_seconds", claim: "Some beta accounts see 30 seconds", value: 30, unit: "seconds", evidence: "Some mention 30 seconds in beta accounts." }
    ]
  },
  {
    id: "iphone16-apple-page",
    title: "iPhone 16 product page snapshot",
    url: "https://demo.local/apple/iphone16",
    platform: "Apple",
    sourceType: "web",
    author: "Apple",
    publishedAt: "2024-09-10",
    duration: null,
    engagement: 25000,
    authorityScore: 0.97,
    summary: "Apple snapshot outlining A18 gains, efficiency improvements and new on-device features in iPhone 16.",
    tags: ["iphone 16", "a18", "apple", "performance", "efficiency"],
    content: {
      markdown: [
        "# iPhone 16 product page snapshot",
        "",
        "Apple positions A18 as delivering a 30 percent CPU uplift over the prior generation baseline used in its presentation.",
        "The same material highlights stronger neural processing and better power efficiency for sustained workloads."
      ].join("\n"),
      keyPoints: [
        "A18 is presented with a 30 percent CPU uplift.",
        "Efficiency gains are a core part of the story.",
        "Neural and sustained performance are emphasized."
      ],
      sections: [
        { heading: "CPU", excerpt: "30 percent CPU uplift in Apple presentation." },
        { heading: "Efficiency", excerpt: "Improved sustained performance and power efficiency." }
      ]
    },
    facts: [
      { subject: "iphone16", kind: "cpu_uplift_percent", claim: "A18 offers 30 percent CPU uplift", value: 30, unit: "percent", evidence: "Delivering a 30 percent CPU uplift." },
      { subject: "iphone16", kind: "efficiency_focus", claim: "Power efficiency is a major improvement area", value: "high", evidence: "Highlights better power efficiency for sustained workloads." }
    ]
  },
  {
    id: "iphone16-benchmark-video",
    title: "iPhone 16 vs iPhone 15 benchmark review",
    url: "https://demo.local/video/iphone16-review",
    platform: "Bilibili",
    sourceType: "video",
    author: "硬件研究室",
    publishedAt: "2024-09-22",
    duration: "22:11",
    engagement: 980000,
    authorityScore: 0.76,
    summary: "Benchmark-oriented video review comparing iPhone 16 and iPhone 15 CPU, GPU and battery behavior.",
    tags: ["iphone 16", "iphone 15", "benchmark", "bilibili", "performance"],
    transcript: [
      { start: "00:55", text: "In short CPU burst tests we see roughly twenty-eight percent uplift over iPhone 15." },
      { start: "06:30", text: "GPU gains are closer to thirty-five percent in the workloads we ran." },
      { start: "13:10", text: "Sustained performance improves because throttling is reduced." }
    ],
    timeline: [
      { start: "00:55", title: "CPU tests", summary: "Finds roughly 28 percent CPU uplift over iPhone 15." },
      { start: "06:30", title: "GPU tests", summary: "Reports around 35 percent GPU uplift." },
      { start: "13:10", title: "Thermals", summary: "Notes better sustained behavior with less throttling." }
    ],
    keyFrames: [
      "Geekbench comparison chart",
      "GPU frame rate table",
      "Thermal throttle curve"
    ],
    facts: [
      { subject: "iphone16", kind: "cpu_uplift_percent", claim: "Measured CPU uplift is about 28 percent", value: 28, unit: "percent", evidence: "We see roughly twenty-eight percent uplift over iPhone 15." },
      { subject: "iphone16", kind: "gpu_uplift_percent", claim: "Measured GPU uplift is about 35 percent", value: 35, unit: "percent", evidence: "GPU gains are closer to thirty-five percent." }
    ]
  },
  {
    id: "iphone16-review-article",
    title: "Independent iPhone 16 review",
    url: "https://demo.local/reviews/iphone16",
    platform: "Tech Review",
    sourceType: "web",
    author: "Dana Hu",
    publishedAt: "2024-09-25",
    duration: null,
    engagement: 65000,
    authorityScore: 0.81,
    summary: "Long-form review discussing benchmark uplift, thermals and whether gains feel noticeable in daily use.",
    tags: ["iphone 16", "review", "performance", "daily use", "thermals"],
    content: {
      markdown: [
        "# Independent iPhone 16 review",
        "",
        "Benchmark uplift is material, but real-world perception depends on gaming, camera pipelines and local AI workloads.",
        "The review agrees the CPU uplift lands around the high twenties and that sustained behavior is meaningfully improved."
      ].join("\n"),
      keyPoints: [
        "Performance gains are real but workload dependent.",
        "High twenties CPU uplift appears credible across tests.",
        "Thermals and sustained behavior are improved."
      ],
      sections: [
        { heading: "Benchmarks", excerpt: "High twenties CPU uplift appears credible." },
        { heading: "Real world", excerpt: "Most noticeable in heavier workloads." }
      ]
    },
    facts: [
      { subject: "iphone16", kind: "cpu_uplift_percent", claim: "Cross-review estimate puts CPU uplift in the high twenties", value: 29, unit: "percent", evidence: "The review agrees the CPU uplift lands around the high twenties." }
    ]
  },
  {
    id: "search-architecture-note",
    title: "Design note for research workflows",
    url: "https://demo.local/notes/research-workflow",
    platform: "Internal Notes",
    sourceType: "document",
    author: "System Design",
    publishedAt: "2026-02-10",
    duration: null,
    engagement: 340,
    authorityScore: 0.72,
    summary: "Design note covering planner-first search, scratchpad memory and evidence-oriented answer synthesis.",
    tags: ["research", "workflow", "planner", "scratchpad", "evidence"],
    content: {
      markdown: [
        "# Design note for research workflows",
        "",
        "Planner-first search improves hit rate by clarifying task goal, sub-questions and stop condition before tool use.",
        "Scratchpad memory reduces repeated searches and keeps evidence traceable across rounds."
      ].join("\n"),
      keyPoints: [
        "Planner-first is the core product differentiator.",
        "Scratchpad turns tool calls into a closed loop."
      ],
      sections: [
        { heading: "Planning", excerpt: "Clarify task goal, sub-questions and stop condition before tool use." }
      ]
    },
    facts: [
      { subject: "deep_web_search", kind: "core_workflow", claim: "Planner-first search is the differentiator", value: "planner_first", evidence: "Planner-first search improves hit rate." }
    ]
  }
];

const samplePrompts = [
  "Sora 模型现在的生成时长上限是多少？相比刚发布时有哪些技术架构上的更新？",
  "苹果 2024 年发布的手机比 2023 年的在性能上提升了多少？",
  "为什么这个产品强调先规划再搜索，而不是直接搜？"
];

module.exports = {
  sources,
  samplePrompts
};
