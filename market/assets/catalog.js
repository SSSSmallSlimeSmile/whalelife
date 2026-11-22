/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 * Generated from catalog.json by tools/generate-catalog.mjs.
 */
window.WHALELIFE_CATALOG = {
  "official": [
    {
      "id": "qq",
      "version": "0.24.0",
      "name": "QQ",
      "author": "iinukami 和贡献者",
      "description": "在 QQ 私聊里延续 WhaleLife 的对话，和白名单好友收发消息。",
      "repository": "https://github.com/iinukami/whalelife-plugin-qq",
      "installation": "https://github.com/iinukami/whalelife-plugin-qq/blob/main/README.md#新安装与-napcat-离线组件",
      "feedback": "https://github.com/iinukami/whalelife-plugin-qq/issues",
      "dependencies": []
    },
    {
      "id": "qzone",
      "version": "0.5.2",
      "name": "QQ 空间",
      "author": "iinukami 和贡献者",
      "description": "浏览好友的空间动态，发表说说，并按白名单设置点赞、评论。",
      "repository": "https://github.com/iinukami/whalelife-plugin-qzone",
      "installation": "https://github.com/iinukami/whalelife-plugin-qzone/blob/main/README.md#服务边界",
      "feedback": "https://github.com/iinukami/whalelife-plugin-qzone/issues",
      "dependencies": [
        "qq"
      ]
    },
    {
      "id": "autonomy",
      "version": "0.6.3",
      "name": "自主性",
      "author": "iinukami 和贡献者",
      "description": "让伙伴记下未完成的念头和约定，在你允许的时段主动接续对话。",
      "repository": "https://github.com/iinukami/whalelife-plugin-autonomy",
      "installation": "https://github.com/iinukami/whalelife-plugin-autonomy/blob/main/README.md#开发与构建",
      "feedback": "https://github.com/iinukami/whalelife-plugin-autonomy/issues",
      "dependencies": []
    },
    {
      "id": "gallery",
      "version": "0.1.4",
      "name": "图库",
      "author": "iinukami 和贡献者",
      "description": "在本地收藏图片和表情，编辑描述与标签，按含义找回需要的那张图。",
      "repository": "https://github.com/iinukami/whalelife-plugin-gallery",
      "installation": "https://github.com/iinukami/whalelife-plugin-gallery/blob/main/README.md#开发与构建",
      "feedback": "https://github.com/iinukami/whalelife-plugin-gallery/issues",
      "dependencies": []
    },
    {
      "id": "surf",
      "version": "0.1.1",
      "name": "网上冲浪",
      "author": "iinukami 和贡献者",
      "description": "搜索公开网页，阅读正文，沿文中的链接继续浏览，也能按需取图。",
      "repository": "https://github.com/iinukami/whalelife-plugin-surf",
      "installation": "https://github.com/iinukami/whalelife-plugin-surf/blob/main/README.md#开发与发行",
      "feedback": "https://github.com/iinukami/whalelife-plugin-surf/issues",
      "dependencies": []
    },
    {
      "id": "bilibili",
      "version": "0.2.10",
      "name": "B 站",
      "author": "iinukami 和贡献者",
      "description": "搜索 B 站视频、读字幕和关注动态，按你的设置参与评论等互动。",
      "repository": "https://github.com/iinukami/whalelife-plugin-bilibili",
      "installation": "https://github.com/iinukami/whalelife-plugin-bilibili/blob/main/README.md#使用流程",
      "feedback": "https://github.com/iinukami/whalelife-plugin-bilibili/issues",
      "dependencies": [
        "surf"
      ]
    },
    {
      "id": "vision",
      "version": "0.5.0",
      "name": "视听理解",
      "author": "iinukami 和贡献者",
      "description": "从图片、视频片段和音频提取画面与声音信息，供伙伴理解和讨论。",
      "repository": "https://github.com/iinukami/whalelife-plugin-vision",
      "installation": "https://github.com/iinukami/whalelife-plugin-vision/blob/main/README.md#开发验证和发行",
      "feedback": "https://github.com/iinukami/whalelife-plugin-vision/issues",
      "dependencies": []
    },
    {
      "id": "computer",
      "version": "0.1.2",
      "name": "电脑与文件",
      "author": "iinukami 和贡献者",
      "description": "按授权查找和编辑 Windows 本地文件、生成文档，在隔离环境中运行离线脚本。",
      "repository": "https://github.com/iinukami/whalelife-plugin-computer",
      "installation": "https://github.com/iinukami/whalelife-plugin-computer/blob/main/README.md#开发检查与构建",
      "feedback": "https://github.com/iinukami/whalelife-plugin-computer/issues",
      "dependencies": []
    }
  ],
  "community": [
    {
      "id": "color-note",
      "version": "0.1.0",
      "name": "颜色便签",
      "author": "iinukami",
      "description": "社区投稿测试插件。保存一条带颜色的本地便签，重启后可继续查看。",
      "repository": "https://github.com/iinukami/whalelife-community-color-note",
      "installation": "https://github.com/iinukami/whalelife-community-color-note/blob/main/README.md#手动安装",
      "feedback": "https://github.com/iinukami/whalelife-community-color-note/issues",
      "dependencies": [],
      "collected": "2026-11-20",
      "stars": 0
    },
    {
      "id": "schedule",
      "version": "0.6.0",
      "name": "日程",
      "author": "FelixTaXk",
      "description": "按作息生成每日日程，可查看、编辑并保存。公开版 WhaleLife 支持这些功能。若要在每轮聊天中自动加入当前和下一项日程，需要作者提供的宿主补丁。",
      "repository": "https://github.com/FelixTaXk/whalelife-community-schedule",
      "installation": "https://github.com/FelixTaXk/whalelife-community-schedule/blob/main/README.md#手动安装",
      "feedback": "https://github.com/FelixTaXk/whalelife-community-schedule/issues",
      "dependencies": [],
      "collected": "2026-11-21",
      "stars": 0,
      "verifiedReleases": [
        {
          "version": "0.6.0",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-schedule/releases/download/v0.6.0/schedule-0.6.0.wlpkg.gz",
          "sizeBytes": 93322,
          "sha256": "ab817409e21be8d88a1f4271dd0e2cac5ce01bd9ebc3353b91bfd834779a082b",
          "dependencies": {},
          "bundledPluginIds": [
            "schedule/weather"
          ]
        },
        {
          "version": "0.4.0",
          "hostRange": "0.1.0",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-schedule/releases/download/v0.4.0/schedule-0.4.0-win32-x64.wlpkg.gz",
          "sizeBytes": 70971,
          "sha256": "a7dbbe859a38d42d5c69b06f4d11187dcb57af60a1e268f74f881f1f0e63019e",
          "dependencies": {},
          "bundledPluginIds": [
            "schedule/weather"
          ]
        }
      ]
    },
    {
      "id": "voice",
      "version": "0.13.1",
      "name": "语音模块",
      "author": "FelixTaXk",
      "description": "管理音色库，合成语音并转换歌声。一键安装包含说话和唱歌两个子插件。使用本机语音引擎时，还需在插件设置中单独部署。",
      "repository": "https://github.com/FelixTaXk/whalelife-community-voice",
      "installation": "https://github.com/FelixTaXk/whalelife-community-voice/blob/main/README.md#手动安装",
      "feedback": "https://github.com/FelixTaXk/whalelife-community-voice/issues",
      "dependencies": [],
      "collected": "2026-11-21",
      "stars": 0,
      "verifiedReleases": [
        {
          "version": "0.13.1",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-voice/releases/download/v0.13.1/voice-0.13.1-win32-x64.wlpkg.gz",
          "sizeBytes": 77210,
          "sha256": "f5909e2fb7e5d0fc835c9f65bafd7a12cbe6916cac8259a3a8356b075ac70e5b",
          "dependencies": {},
          "bundledPluginIds": [
            "voice/speak",
            "voice/sing"
          ]
        },
        {
          "version": "0.9.4",
          "hostRange": "0.1.0",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-voice/releases/download/v0.9.4/voice-0.9.4-win32-x64.wlpkg.gz",
          "sizeBytes": 72070,
          "sha256": "1614142302ac180d767b6d9959447ec6c7b139e3a62b5d8b6ac2e0d815e5379d",
          "dependencies": {},
          "bundledPluginIds": [
            "voice/sing",
            "voice/speak"
          ]
        }
      ]
    },
    {
      "id": "studio",
      "version": "0.2.15",
      "name": "画室",
      "author": "FelixTaXk",
      "description": "用本地 ComfyUI、SD-WebUI 或兼容接口生成图片，附带视频和提示词小抄。看图与绘制蒙版需 Python 和 Pillow。",
      "repository": "https://github.com/FelixTaXk/whalelife-community-studio",
      "installation": "https://github.com/FelixTaXk/whalelife-community-studio/blob/main/README.md#手动安装",
      "feedback": "https://github.com/FelixTaXk/whalelife-community-studio/issues",
      "dependencies": [],
      "collected": "2026-11-21",
      "stars": 0,
      "verifiedReleases": [
        {
          "version": "0.2.15",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-studio/releases/download/v0.2.15/studio-0.2.15-win32-x64.wlpkg.gz",
          "sizeBytes": 155912,
          "sha256": "aa8236ec1a3ad6178e1c9f01dbd2ce5f13dfd81ccffab20b62252e840f5cf81d",
          "dependencies": {},
          "bundledPluginIds": [
            "studio/image",
            "studio/promptkit",
            "studio/video"
          ]
        },
        {
          "version": "0.2.6",
          "hostRange": "0.1.0",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-studio/releases/download/v0.2.6/studio-0.2.6-win32-x64.wlpkg.gz",
          "sizeBytes": 141194,
          "sha256": "3c828e541ecdd8f168545cccfed2a6c3872dce67fa4f4ceb05be02eaa41d5fb6",
          "dependencies": {},
          "bundledPluginIds": [
            "studio/image",
            "studio/promptkit",
            "studio/video"
          ]
        },
        {
          "version": "0.2.2",
          "hostRange": "0.1.0",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-studio/releases/download/v0.2.2/studio-0.2.2-win32-x64.wlpkg.gz",
          "sizeBytes": 120344,
          "sha256": "c6e37794d7fe77617ca4344e8d6a9a11c2b9c73fcb5164044b0e51abb0871767",
          "dependencies": {},
          "bundledPluginIds": [
            "studio/image",
            "studio/promptkit",
            "studio/video"
          ]
        }
      ]
    },
    {
      "id": "thinking-space",
      "version": "0.1.0",
      "name": "思维空间",
      "author": "SSSSmallSlimeSmile",
      "description": "把多个插件的工具组合成可重复运行的技能，在技能库或画布中编辑和试跑。",
      "repository": "https://github.com/SSSSmallSlimeSmile/WhaleLife-thinking-space",
      "installation": "https://github.com/SSSSmallSlimeSmile/WhaleLife-thinking-space/blob/819abcf10c8614e5c2886241c3b4a8321cc3285b/README.md#二怎么装",
      "feedback": "https://github.com/SSSSmallSlimeSmile/WhaleLife-thinking-space/issues",
      "dependencies": [],
      "collected": "2026-11-21",
      "stars": 0,
      "verifiedReleases": [
        {
          "version": "0.1.0",
          "hostRange": "0.1.0",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/SSSSmallSlimeSmile/WhaleLife-thinking-space/releases/download/v0.1.0/thinking-space-0.1.0.wlpkg.gz",
          "sizeBytes": 235194,
          "sha256": "0c75ad7c9a1bbd8b9764b883c6441032d69c4805086807d165053b91f354bf44",
          "dependencies": {}
        },
        {
          "version": "0.1.0",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/SSSSmallSlimeSmile/WhaleLife-thinking-space/releases/download/v0.1.0/thinking-space-0.1.0.wlpkg.gz",
          "sizeBytes": 235194,
          "sha256": "0c75ad7c9a1bbd8b9764b883c6441032d69c4805086807d165053b91f354bf44",
          "dependencies": {}
        }
      ]
    },
    {
      "id": "surf/douyin",
      "version": "0.1.6",
      "name": "抖音",
      "author": "FelixTaXk",
      "description": "在「网上冲浪」里浏览抖音推荐、搜索视频、观看片段、阅读评论并参与互动。",
      "repository": "https://github.com/FelixTaXk/whalelife-community-douyin",
      "installation": "https://github.com/FelixTaXk/whalelife-community-douyin/blob/cd02451d8d61b84b02054a3670673b26dfab7100/README.md#装在哪",
      "feedback": "https://github.com/FelixTaXk/whalelife-community-douyin/issues",
      "dependencies": [
        "surf"
      ],
      "collected": "2026-11-22",
      "stars": 0,
      "verifiedReleases": [
        {
          "version": "0.1.6",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "dependencies": {
            "surf": "0.1.1"
          },
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-douyin/releases/download/v0.1.6/douyin-0.1.6-win32-x64.wlpkg.gz",
          "sha256": "b6bdf880b0c37174b563957cff4def18b939291a0a2d18a90e758ea4a0f90848",
          "sizeBytes": 74042
        },
        {
          "version": "0.1.5",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-douyin/releases/download/v0.1.5/douyin-0.1.5-win32-x64.wlpkg.gz",
          "sizeBytes": 71636,
          "sha256": "bbb7d08f099a320573c426c975bb49a7c56faa25c63df322b794ee63668039bf",
          "dependencies": {
            "surf": "0.1.1"
          }
        }
      ]
    },
    {
      "id": "qq/group",
      "version": "0.6.10",
      "name": "QQ 群聊",
      "author": "FelixTaXk",
      "description": "为 QQ 添加群聊，可按群设置回复方式和人格，管理群友标签、引用消息和群语音。安装需要宿主商店能提供官方 QQ v0.24.0。",
      "repository": "https://github.com/FelixTaXk/whalelife-community-qq-group",
      "installation": "https://github.com/FelixTaXk/whalelife-community-qq-group/blob/e84f673d2a24ab3e97ef8efabecf8b9c82519995/README.md",
      "feedback": "https://github.com/FelixTaXk/whalelife-community-qq-group/issues",
      "dependencies": [
        "qq"
      ],
      "collected": "2026-11-22",
      "stars": 0,
      "verifiedReleases": [
        {
          "version": "0.6.10",
          "hostRange": "0.1.1",
          "platform": "win32",
          "arch": "x64",
          "dependencies": {
            "qq": "0.24.0"
          },
          "assetUrl": "https://github.com/FelixTaXk/whalelife-community-qq-group/releases/download/v0.6.10/qq-group-0.6.10-win32-x64.wlpkg.gz",
          "sha256": "4d298a9a1f637ee4c564e5a93afd4258a0e226af6fb27e85fbe4f396277fae5b",
          "sizeBytes": 49302
        }
      ]
    }
  ]
};
