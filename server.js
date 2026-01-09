// server.js - Audio2Face Backend Service
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { spawn } = require('child_process');
const yaml = require('js-yaml');

const app = express();
const PORT = 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 文件上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// 模型配置
const MODEL_CONFIG = {
    claire: { 
        functionId: '0961a6da-fb9e-4f2e-8491-247e5fd7bf8d',
        config: 'config_claire.yml'
    },
    mark: { 
        functionId: '8efc55f5-6f00-424e-afe9-26212cd2c630',
        config: 'config_mark.yml'
    },
    james: { 
        functionId: '9327c39f-a361-4e02-bd72-e11b4c9b7b5e',
        config: 'config_james.yml'
    }
};

// 主要 API 端点:处理音频并调用 Audio2Face
app.post('/api/generate-animation', upload.single('audio'), async (req, res) => {
    const { model, apiKey } = req.body;
    const audioFile = req.file;

    console.log('收到请求:', { model, apiKey: apiKey?.substring(0, 20) + '...', audioFile: audioFile?.filename });

    if (!audioFile || !model || !apiKey) {
        return res.status(400).json({ 
            error: '缺少必要参数',
            details: {
                hasAudio: !!audioFile,
                hasModel: !!model,
                hasApiKey: !!apiKey
            }
        });
    }

    try {
        // 转换音频为 PCM 16-bit WAV
        const pcmAudioPath = await convertToPCM16(audioFile.path);
        console.log('音频转换完成:', pcmAudioPath);
        
        // 调用 Audio2Face Python 客户端
        const animationData = await callAudio2FaceAPI(
            pcmAudioPath,
            model,
            apiKey
        );

        // 清理临时文件
        fs.unlinkSync(audioFile.path);
        fs.unlinkSync(pcmAudioPath);

        res.json({
            success: true,
            data: animationData
        });

    } catch (error) {
        console.error('处理错误:', error);
        res.status(500).json({ 
            error: '处理失败',
            message: error.message 
        });
    }
});

// 转换音频为 PCM 16-bit WAV (使用 ffmpeg)
function convertToPCM16(inputPath) {
    return new Promise((resolve, reject) => {
        const outputPath = inputPath.replace(/\.[^.]+$/, '_pcm.wav');
        console.log(`正在转换音频文件: ${inputPath} -> ${outputPath}`);
        const ffmpeg = spawn('ffmpeg', [
            '-i', inputPath,
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-y',
            outputPath
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`音频转换成功: ${outputPath}`);
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg 转换失败,代码: ${code}`));
            }
        });

        ffmpeg.stderr.on('data', (data) => {
            console.log(`FFmpeg: ${data}`);
        });
    });
}

// 调用 Audio2Face Python 客户端

function callAudio2FaceAPI(audioPath, model, apiKey) {
    return new Promise((resolve, reject) => {
        const config = MODEL_CONFIG[model];
        if (!config) {
            return reject(new Error('不支持的模型'));
        }

        // ⭐ 关键：使用虚拟环境里的 python
        const pythonPath = path.join(
            __dirname,
            'Audio2Face-3D-Samples',
            'myenv311',
            'bin',
            'python'
        );

        const pythonScript = path.join(
            __dirname,
            'Audio2Face-3D-Samples',
            'scripts',
            'audio2face_3d_api_client',
            'nim_a2f_3d_client.py'
        );

        const configFile = path.join(
            __dirname,
            'Audio2Face-3D-Samples',
            'scripts',
            'audio2face_3d_api_client',
            'config',
            config.config
        );

        console.log(`使用 Python: ${pythonPath}`);
        console.log(`调用 Python 脚本: ${pythonScript}`);

        const python = spawn(pythonPath, [
            pythonScript,
            audioPath,
            configFile,
            '--apikey', apiKey,
            '--function-id', config.functionId
        ]);

        let output = '';
        let errorOutput = '';

        python.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`Python 输出: ${data}`);
        });

        python.stderr.on('data', (data) => {
            errorOutput += data.toString();
            console.error(`Python 错误: ${data}`);
        });

        python.on('close', (code) => {
            if (code === 0) {
                try {
                    const animationData = parseAnimationOutput(output);
                    resolve(animationData);
                } catch (err) {
                    reject(new Error('解析动画数据失败: ' + err.message));
                }
            } else {
                reject(new Error(`Python 脚本失败: ${errorOutput}`));
            }
        });
    });
}
// function callAudio2FaceAPI(audioPath, model, apiKey) {
//     return new Promise((resolve, reject) => {
//         const config = MODEL_CONFIG[model];
//         if (!config) {
//             return reject(new Error('不支持的模型'));
//         }

//         const pythonScript = path.join(__dirname, 'Audio2Face-3D-Samples', 'scripts', 'audio2face_3d_api_client', 'nim_a2f_3d_client.py');
//         const configFile = path.join(__dirname, 'audio2face_client', 'config', config.config);

//         console.log(`调用 Python 脚本: ${pythonScript}`);
//         console.log(`音频路径: ${audioPath}, 配置文件: ${configFile}`);

//         const python = spawn('python3', [
//             pythonScript,
//             audioPath,
//             configFile,
//             '--apikey', apiKey,
//             '--function-id', config.functionId,
//             '--output-json'
//         ]);

//         let output = '';
//         let errorOutput = '';

//         python.stdout.on('data', (data) => {
//             output += data.toString();
//             console.log(`Python 输出: ${data}`);
//         });

//         python.stderr.on('data', (data) => {
//             errorOutput += data.toString();
//             console.error(`Python 错误: ${data}`);
//         });

//         python.on('close', (code) => {
//             if (code === 0) {
//                 try {
//                     const animationData = parseAnimationOutput(output);
//                     console.log('解析后的动画数据:', animationData);
//                     resolve(animationData);
//                 } catch (error) {
//                     reject(new Error('解析动画数据失败: ' + error.message));
//                 }
//             } else {
//                 reject(new Error(`Python 脚本失败: ${errorOutput}`));
//             }
//         });
//     });
// }

// 解析动画输出数据
function parseAnimationOutput(output) {
    // 如果是 JSON 格式
    try {
        return JSON.parse(output);
    } catch (e) {
        // 如果是 CSV 格式,解析 CSV
        const lines = output.split('\n').filter(line => line.trim());
        const blendshapes = [];
        
        for (let i = 1; i < lines.length; i++) { // 跳过头部
            const [name, value, time] = lines[i].split(',');
            if (name && value && time) {
                blendshapes.push({
                    name: name.trim(),
                    value: parseFloat(value),
                    time: parseFloat(time)
                });
            }
        }
        
        return { blendshapes };
    }
}

// 健康检查端点
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        message: 'Audio2Face 服务运行中',
        timestamp: new Date().toISOString()
    });
});

// 获取模型配置端点
app.get('/api/model-config/:model', (req, res) => {
    const { model } = req.params;
    const modelConfigs = {
        claire: 'config_claire.yml',
        mark: 'config_mark.yml',
        james: 'config_james.yml'
    };

    const configFile = modelConfigs[model];
    if (!configFile) {
        return res.status(400).json({ error: '不支持的模型' });
    }

    const configPath = path.join(__dirname, 'audio2face_client', 'config', configFile);
    
    try {
        const yamlContent = fs.readFileSync(configPath, 'utf8');
        const config = yaml.load(yamlContent);
        const blendshapeId = config.a2f?.blendshape_id;
        
        if (!blendshapeId) {
            return res.status(500).json({ 
                error: '模型配置中缺少 blendshape_id' 
            });
        }
        
        res.json({
            success: true,
            data: {
                blendshape_id: blendshapeId
            }
        });
    } catch (error) {
        console.error('读取模型配置失败:', error);
        res.status(500).json({  
            error: '读取模型配置失败',
            message: error.message 
        });
    }
});

// 测试端点:返回模拟数据
app.post('/api/test-animation', upload.single('audio'), (req, res) => {
    console.log('测试模式:返回模拟数据');
    
    // 生成模拟的 blendshape 动画数据
    const mockData = {
        blendshapes: [],
        duration: 3.0
    };

    // 常见的 ARKit blendshapes
    const blendshapeNames = [
        'jawOpen', 'mouthSmile', 'mouthPucker', 'mouthFrown',
        'eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'browOuterUpLeft'
    ];

    // 生成 30 帧的动画数据 (每秒 10 帧)
    for (let frame = 0; frame < 30; frame++) {
        const time = frame * 0.1;
        
        blendshapeNames.forEach(name => {
            let value;
            if (name === 'jawOpen') {
                // 嘴巴开合动画
                value = Math.abs(Math.sin(frame * 0.5)) * 0.8;
            } else if (name.includes('Smile')) {
                value = Math.random() * 0.3;
            } else {
                value = Math.random() * 0.2;
            }
            
            mockData.blendshapes.push({
                name,
                value,
                time
            });
        });
    }

    res.json({
        success: true,
        data: mockData,
        note: '这是模拟数据,用于测试'
    });
});

// 静态文件服务（必须在所有 API 路由之后）
app.use(express.static('public')); // 提供前端文件
app.use('/audio2face_client/config', express.static(path.join(__dirname, 'audio2face_client/config')));
app.use('/models', express.static(path.join(__dirname, 'models')));

// 启动服务器
app.listen(PORT, () => {
    console.log(`\n🚀 Audio2Face 后端服务已启动`);
    console.log(`📡 服务地址: http://localhost:${PORT}`);
    console.log(`🧪 测试端点: http://localhost:${PORT}/api/health`);
    console.log(`📁 前端文件: ./public/index.html\n`);
});

// 错误处理
process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的 Promise 拒绝:', reason);
});
