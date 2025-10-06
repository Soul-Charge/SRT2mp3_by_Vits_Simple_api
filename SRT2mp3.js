// SRT2mp3.js (版本 6.6 - 手动计算Loudnorm偏移量)

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { getAudioDurationInSeconds } = require('get-audio-duration');
const readline = require('readline');

// --- 配置部分 ---
const VITS_API_BASE_URL = 'http://127.0.0.1:23456/voice/vits';
const SPEAKER_ID = 2894;
const SRT_DIR = './srt';
const OUT_DIR = './out';
const TEMP_DIR = './temp_audio';
const DICT_FILE_PATH = './dict.json';
const TARGET_LOUDNESS = -16.0; // 目标响度 LUFS
// --- 配置结束 ---

// ===================================================================
// 功能函数 (normalizeAudio 已重写)
// ===================================================================

/**
 * [!! 最终修复 !!]
 * 使用两遍处理Loudnorm，并手动计算偏移量，绕过ffmpeg内部计算错误
 * @param {string} inputPath 输入文件路径
 * @param {string} outputPath 输出文件路径
 */
async function normalizeAudio(inputPath, outputPath) {
    console.log(`\n[最终版] 正在进行两遍音量标准化 (目标 ${TARGET_LOUDNESS} LUFS)...`);

    // ------------------- Pass 1: 分析音频 -------------------
    const measuredStats = await new Promise((resolve, reject) => {
        let stderr = '';
        console.log("第一遍: 正在分析音频响度...");
        ffmpeg(inputPath)
            .audioFilter(`loudnorm=I=${TARGET_LOUDNESS}:LRA=11:tp=-1.5:print_format=json`)
            .outputOptions('-f', 'null')
            .on('stderr', (line) => { stderr += line.toString(); })
            .on('end', () => {
                try {
                    const jsonPart = stderr.substring(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
                    if (!jsonPart) throw new Error("在FFMPEG日志中未找到JSON数据块。");
                    const stats = JSON.parse(jsonPart);
                    console.log("分析完成。测量出的响度(input_i):", stats.input_i);
                    resolve(stats);
                } catch (e) { reject(new Error("解析Loudnorm分析数据失败: " + e.message)); }
            })
            .on('error', (err) => { reject(new Error("Loudnorm第一遍分析失败: " + err.message)); })
            .save('-');
    });

    // ------------------- Pass 2: 应用标准化 (手动计算Offset) -------------------
    await new Promise((resolve, reject) => {
        console.log("第二遍: 正在应用精确的音量调整...");

        // [!! 核心修复 !!] 手动计算正确的 offset
        const measured_i_float = parseFloat(measuredStats.input_i);
        const calculated_offset = TARGET_LOUDNESS - measured_i_float;
        
        console.log(`FFmpeg建议的offset: ${measuredStats.target_offset} (不可靠)`);
        console.log(`我们手动计算的offset: ${calculated_offset.toFixed(2)} (将使用此值)`);

        const filterOptions = {
            I: TARGET_LOUDNESS,
            LRA: 11,
            tp: -1.5,
            measured_i: measuredStats.input_i,
            measured_lra: measuredStats.input_lra,
            measured_tp: measuredStats.input_tp,
            measured_thresh: measuredStats.input_thresh,
            offset: calculated_offset.toFixed(2) // 使用我们自己计算的值
        };
        const filterString = 'loudnorm=' + Object.entries(filterOptions).map(([key, val]) => `${key}=${val}`).join(':');

        ffmpeg(inputPath)
            .audioFilter(filterString)
            .on('end', () => {
                console.log(`标准化完成, 文件已保存至: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => { reject(new Error("Loudnorm第二遍应用失败: " + err.message)); })
            .save(outputPath);
    });
}


// (其余代码与上一版相同，为保证完整性，一并附上)
function cleanupText(text) {
    let cleanedText = text;
    const complexKaomojiRegex = /([\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u3000-\u303F\uFF00-\uFFEF\uE000-\uF8FF]|\([^)]*\)|[（[^）]*）]){2,}/g;
    cleanedText = cleanedText.replace(complexKaomojiRegex, '');
    const simpleEmoticonRegex = /\s*(qwq|qaq|owo|ovo|t_t|;\-;|:\)|:\(|:p|:d|=v=)\s*/gi;
    cleanedText = cleanedText.replace(simpleEmoticonRegex, ' ');
    cleanedText = cleanedText.replace(/[（(]([^a-zA-Z0-9\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]+?)[)）]/g, '');
    return cleanedText.trim().replace(/\s+/g, ' ');
}

function replaceTextWithDictionary(text, dictionary) {
    if (!dictionary) { return text; }
    let modifiedText = text;
    const sortedKeys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
        const entry = dictionary[key];
        const flags = 'g' + (entry.caseSensitive ? '' : 'i');
        try {
            const regex = new RegExp(key, flags);
            modifiedText = modifiedText.replace(regex, entry.value);
        } catch (e) {
            console.warn(`[词典警告] 正则表达式无效: "${key}". 已跳过。`);
        }
    }
    return modifiedText;
}

async function processSrtFile(srtFilePath, outputFilePath, SrtParser, dictionary) {
    if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEMP_DIR);

    console.log(`\n正在解析文件: ${srtFilePath}`);
    const srtContent = fs.readFileSync(srtFilePath, 'utf8');
    const parser = new SrtParser(); 
    const subtitles = parser.fromSrt(srtContent);
    const clipsToMerge = [];

    for (const sub of subtitles) {
        const index = parseInt(sub.id, 10);
        const originalText = sub.text;
        const cleanedText = cleanupText(originalText);
        const modifiedText = replaceTextWithDictionary(cleanedText, dictionary);

        if (originalText !== modifiedText) {
            console.log(`[${index}] 文本处理: "${originalText}" -> "${modifiedText}"`);
        }
        if (!modifiedText.trim()) {
            console.log(`[${index}] 文本处理后为空，已跳过。`);
            continue;
        }
        
        const subtitleDuration = (timeStringToMs(sub.endTime) - timeStringToMs(sub.startTime)) / 1000.0;
        const originalAudioPath = await textToSpeech(modifiedText, index);
        if (!originalAudioPath) continue;

        const generatedAudioDuration = await getAudioDurationInSeconds(originalAudioPath);
        console.log(`[${index}] 字幕时长: ${subtitleDuration.toFixed(2)}s, 生成音频时长: ${generatedAudioDuration.toFixed(2)}s`);

        let finalAudioPath = originalAudioPath;
        if (generatedAudioDuration > subtitleDuration && subtitleDuration > 0) {
            const speed = generatedAudioDuration / subtitleDuration;
            const processedAudioPath = path.join(TEMP_DIR, `processed_${index}.mp3`);
            finalAudioPath = await processAudio(originalAudioPath, processedAudioPath, speed);
        } else {
            console.log(`[${index}] 音频时长未超出，无需变速。`);
        }
        clipsToMerge.push({ path: finalAudioPath, startTime: sub.startTime });
    }

    if (clipsToMerge.length > 0) {
        const tempMergedPath = path.join(OUT_DIR, `temp_merged_${Date.now()}.mp3`);
        await mergeAudiosWithTiming(clipsToMerge, tempMergedPath);
        await normalizeAudio(tempMergedPath, outputFilePath);
        fs.unlinkSync(tempMergedPath);
    } else {
        console.log("没有生成任何音频文件，无法合并。");
    }
    console.log("\n临时文件保留在 temp_audio 目录中，方便检查。可手动删除。");
}

async function main() {
    const { default: SrtParser } = await import('srt-parser-2');
    let dictionary = null;
    if (fs.existsSync(DICT_FILE_PATH)) {
        try {
            dictionary = JSON.parse(fs.readFileSync(DICT_FILE_PATH, 'utf8'));
            console.log(`成功加载词典: ${DICT_FILE_PATH}`);
        } catch (e) {
            console.error(`加载或解析词典文件失败: ${e.message}`);
        }
    } else {
        console.warn(`警告: 未在 ${DICT_FILE_PATH} 找到词典文件，将不执行关键词替换。`);
    }

    if (!fs.existsSync(SRT_DIR)) {
        fs.mkdirSync(SRT_DIR);
        console.log(`SRT 目录 '${SRT_DIR}' 不存在，已自动创建。请将 .srt 文件放入其中。`);
        return;
    }
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    const srtFiles = fs.readdirSync(SRT_DIR).filter(file => file.toLowerCase().endsWith('.srt'));
    if (srtFiles.length === 0) {
        console.log(`在 '${SRT_DIR}' 目录中未找到任何 .srt 文件。`);
        return;
    }

    console.log("请选择要处理的 SRT 文件:");
    srtFiles.forEach((file, index) => console.log(`  [${index + 1}] ${file}`));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));
    const answer = await question('\n请输入文件对应的序号: ');
    rl.close();

    const selectedIndex = parseInt(answer, 10) - 1;
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= srtFiles.length) {
        console.error("无效的序号！");
        return;
    }

    const selectedSrtFile = srtFiles[selectedIndex];
    const srtFilePath = path.join(SRT_DIR, selectedSrtFile);
    const outputFileName = `${path.basename(selectedSrtFile, '.srt')}.mp3`;
    const outputFilePath = path.join(OUT_DIR, outputFileName);
    
    await processSrtFile(srtFilePath, outputFilePath, SrtParser, dictionary);
}

function timeStringToMs(timeString) {
    const [hms, ms] = timeString.split(',');
    const [h, m, s] = hms.split(':').map(Number);
    return (h * 3600 + m * 60 + s) * 1000 + Number(ms);
}

async function textToSpeech(text, index) {
    try {
        console.log(`[${index}] 正在生成语音: ${text}`);
        const params = new URLSearchParams({ id: SPEAKER_ID, format: 'mp3', lang: 'auto', text: text });
        const fullUrl = `${VITS_API_BASE_URL}?${params.toString()}`;
        const response = await axios.get(fullUrl, { responseType: 'arraybuffer' });
        const audioPath = path.join(TEMP_DIR, `temp_${index}.mp3`);
        fs.writeFileSync(audioPath, response.data);
        return audioPath;
    } catch (error) {
        console.error(`[${index}] API 请求失败: ${error.message}`);
        if (error.response) { console.error('错误状态:', error.response.status); }
        return null;
    }
}

function processAudio(inputPath, outputPath, speed) {
    return new Promise((resolve, reject) => {
        console.log(`[变速处理] 速度: ${speed.toFixed(2)}x, 文件: ${path.basename(inputPath)}`);
        ffmpeg(inputPath)
            .audioFilter(`atempo=${speed}`)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

function mergeAudiosWithTiming(audioClips, finalOutputPath) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg();
        let mixInputs = '';
        const complexFilter = audioClips.map((clip, index) => {
            command.input(clip.path);
            mixInputs += `[a${index}]`;
            return `[${index}:a]adelay=${timeStringToMs(clip.startTime)}|${timeStringToMs(clip.startTime)}[a${index}]`;
        });
        complexFilter.push(`${mixInputs}amix=inputs=${audioClips.length}:duration=longest`);
        
        console.log(`\n正在按时间码混合 ${audioClips.length} 个音频文件...`);
        command
            .complexFilter(complexFilter)
            .audioCodec('libmp3lame')
            .on('end', () => {
                console.log(`音频片段混合完成，临时保存至: ${finalOutputPath}`);
                resolve(finalOutputPath);
            })
            .on('error', (err) => {
                console.error('混合失败:', err.message);
                reject(err);
            })
            .save(finalOutputPath);
    });
}

main().catch(console.error);