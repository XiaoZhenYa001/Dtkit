export const exampleCodes = {
    hello: {
        html: `<div class="hello-container">
    <h1>👋 Hello World!</h1>
    <p>欢迎使用 HTML 代码预览工具</p>
    <button id="helloButton">点击我</button>
</div>`,
        css: `.hello-container {
    text-align: center;
    padding: 40px;
    font-family: -apple-system, sans-serif;
}

h1 {
    color: #1e293b;
    font-size: 2.5rem;
    margin-bottom: 10px;
}

p {
    color: #64748b;
    margin-bottom: 20px;
}

button {
    padding: 12px 24px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
}

button:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(99, 102, 241, 0.3);
}`,
        js: `document.getElementById('helloButton').addEventListener('click', () => {
    document.querySelector('.hello-container p').textContent = '你好，世界！交互已经生效。';
});`
    },
    button: {
        html: `<div class="button-showcase">
    <button class="btn btn-primary">主要按钮</button>
    <button class="btn btn-secondary">次要按钮</button>
    <button class="btn btn-outline">边框按钮</button>
    <button class="btn btn-ghost">幽灵按钮</button>
</div>`,
        css: `.button-showcase {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    justify-content: center;
    padding: 40px;
    font-family: -apple-system, sans-serif;
}

.btn {
    padding: 12px 28px;
    font-size: 14px;
    font-weight: 500;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.3s ease;
    border: 2px solid transparent;
}

.btn-primary {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
}

.btn-primary:hover {
    transform: translateY(-3px);
    box-shadow: 0 10px 25px rgba(99, 102, 241, 0.35);
}

.btn-secondary {
    background: #f1f5f9;
    color: #475569;
}

.btn-secondary:hover {
    background: #e2e8f0;
}

.btn-outline {
    background: transparent;
    border-color: #6366f1;
    color: #6366f1;
}

.btn-outline:hover {
    background: #6366f1;
    color: white;
}

.btn-ghost {
    background: transparent;
    color: #6366f1;
}

.btn-ghost:hover {
    background: rgba(99, 102, 241, 0.1);
}`,
        js: ``
    },
    card: {
        html: `<div class="card">
    <div class="card-image">
        <span class="card-badge">热门</span>
    </div>
    <div class="card-content">
        <h3 class="card-title">精美卡片组件</h3>
        <p class="card-desc">这是一个具有现代设计感的卡片组件示例，包含图片占位、标题、描述和操作按钮。</p>
        <div class="card-footer">
            <span class="card-price">¥99</span>
            <button class="card-btn">立即购买</button>
        </div>
    </div>
</div>`,
        css: `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    background: #f1f5f9;
    font-family: -apple-system, sans-serif;
}

.card {
    width: 300px;
    background: white;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
    transition: transform 0.3s, box-shadow 0.3s;
}

.card:hover {
    transform: translateY(-8px);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.15);
}

.card-image {
    height: 160px;
    background: linear-gradient(135deg, #6366f1, #ec4899);
    position: relative;
}

.card-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    padding: 4px 12px;
    background: rgba(255, 255, 255, 0.9);
    color: #ec4899;
    font-size: 12px;
    font-weight: 600;
    border-radius: 20px;
}

.card-content {
    padding: 20px;
}

.card-title {
    font-size: 18px;
    color: #1e293b;
    margin-bottom: 10px;
}

.card-desc {
    font-size: 14px;
    color: #64748b;
    line-height: 1.6;
    margin-bottom: 16px;
}

.card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.card-price {
    font-size: 24px;
    font-weight: 700;
    color: #6366f1;
}

.card-btn {
    padding: 10px 20px;
    background: #6366f1;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.2s;
}

.card-btn:hover {
    background: #4f46e5;
}`,
        js: ``
    },
    animation: {
        html: `<div class="animation-demo">
    <div class="circle circle-1"></div>
    <div class="circle circle-2"></div>
    <div class="circle circle-3"></div>
    <p class="loading-text">加载中...</p>
</div>`,
        css: `.animation-demo {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: 20px;
    background: linear-gradient(135deg, #1e1b4b, #312e81);
}

.circle {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    position: absolute;
}

.animation-demo {
    position: relative;
}

.circle-1 {
    background: #6366f1;
    animation: bounce 1.2s ease-in-out infinite;
    left: calc(50% - 40px);
}

.circle-2 {
    background: #8b5cf6;
    animation: bounce 1.2s ease-in-out 0.2s infinite;
    left: 50%;
    transform: translateX(-50%);
}

.circle-3 {
    background: #a855f7;
    animation: bounce 1.2s ease-in-out 0.4s infinite;
    left: calc(50% + 20px);
}

@keyframes bounce {
    0%, 100% {
        top: 50%;
        transform: translateY(-50%);
    }
    50% {
        top: calc(50% - 30px);
        transform: translateY(-50%);
    }
}

.loading-text {
    color: rgba(255, 255, 255, 0.7);
    font-family: -apple-system, sans-serif;
    font-size: 14px;
    margin-top: 60px;
    letter-spacing: 2px;
}`,
        js: ``
    }
};
