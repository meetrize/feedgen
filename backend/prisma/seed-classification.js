/**
 * 写入常用新闻资讯分类（幂等：按 code upsert）
 * 执行：cd backend && node prisma/seed-classification.js
 */
const path = require('path');

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

/** @type {Array<{ code: string; name: string; description: string; color: string; sort_order: number; examples: string[] }>} */
const DEFAULT_CATEGORIES = [
  {
    code: 'politics',
    name: '时政',
    description: '国内政治、政策法规、领导人活动与政务新闻',
    color: '#c0392b',
    sort_order: 10,
    examples: [
      '国务院召开常务会议部署稳经济举措',
      '全国人大常委会审议多部法律草案',
      '外交部发言人就热点问题答记者问',
      '多地出台优化营商环境新政策',
    ],
  },
  {
    code: 'finance',
    name: '财经',
    description: '宏观经济、股市债市、企业与行业财经动态',
    color: '#e67e22',
    sort_order: 20,
    examples: [
      '央行宣布下调存款准备金率',
      'A股三大指数集体收涨',
      '多家银行调整存款利率',
      '新能源汽车销量再创新高',
    ],
  },
  {
    code: 'tech',
    name: '科技',
    description: '互联网、人工智能、数码产品与科技创新',
    color: '#2980b9',
    sort_order: 30,
    examples: [
      '国务院印发人工智能产业发展意见',
      '国产大模型宣布开放API接口',
      '苹果发布新一代智能手机',
      '多家科技公司公布季度财报',
    ],
  },
  {
    code: 'society',
    name: '社会',
    description: '民生热点、社会事件、法治与公共事务',
    color: '#27ae60',
    sort_order: 40,
    examples: [
      '多地迎来强降雨天气过程',
      '春运返程客流持续高位运行',
      '警方通报一起网络诈骗案件',
      '教育部回应义务教育热点问题',
    ],
  },
  {
    code: 'sports',
    name: '体育',
    description: '赛事赛果、运动员动态与体育产业',
    color: '#8e44ad',
    sort_order: 50,
    examples: [
      '中国队夺得世界杯预选赛关键胜利',
      'NBA常规赛上演绝杀好戏',
      '奥运会中国代表团再添金牌',
      '中超联赛新赛季赛程公布',
    ],
  },
  {
    code: 'entertainment',
    name: '娱乐',
    description: '影视综艺、明星动态与文娱产业',
    color: '#e91e63',
    sort_order: 60,
    examples: [
      '春节档电影总票房突破新高',
      '知名歌手宣布巡回演唱会计划',
      '热播电视剧收官引发讨论',
      '电影节公布获奖名单',
    ],
  },
  {
    code: 'international',
    name: '国际',
    description: '国际政治、外交关系与海外重大事件',
    color: '#16a085',
    sort_order: 70,
    examples: [
      '联合国安理会就地区局势举行会议',
      '美联储维持基准利率不变',
      '欧洲多国领导人举行联合峰会',
      '中东局势出现新变化',
    ],
  },
  {
    code: 'health',
    name: '健康',
    description: '医疗卫生、疾病防控、养生与公共卫生',
    color: '#1abc9c',
    sort_order: 80,
    examples: [
      '国家卫健委发布流感防控提示',
      '新药获批上市用于治疗罕见病',
      '多地启动老年人免费体检项目',
      '专家解读夏季常见传染病预防',
    ],
  },
  {
    code: 'military',
    name: '军事',
    description: '国防建设、军队动态与军事演习',
    color: '#34495e',
    sort_order: 90,
    examples: [
      '国防部举行例行记者会',
      '海军编队完成远海训练任务',
      '空军新型战机亮相公开活动',
      '多国举行联合军事演习',
    ],
  },
  {
    code: 'education',
    name: '教育',
    description: '学校教育、考试招生与教育政策',
    color: '#3498db',
    sort_order: 100,
    examples: [
      '2026年高考报名工作正式启动',
      '教育部推进义务教育优质均衡',
      '多所高校公布研究生复试线',
      '职业教育改革实施方案发布',
    ],
  },
];

function vectorToBytes(vector) {
  const arr = new Float32Array(vector);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

async function rebuildPrototype(examples) {
  const baseUrl = (process.env.ML_SERVICE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
  const token = process.env.ML_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new Error('ML_SERVICE_TOKEN 未配置');
  }

  const response = await axios.post(
    `${baseUrl}/internal/prototype/rebuild`,
    { examples },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
      },
      timeout: 120_000,
    },
  );
  return response.data;
}

async function syncPrototype(categoryId, examples) {
  if (!examples.length) {
    await prisma.newsCategoryPrototype.deleteMany({ where: { category_id: categoryId } });
    return false;
  }

  const rebuilt = await rebuildPrototype(examples);
  const embedding = vectorToBytes(rebuilt.prototype);

  await prisma.newsCategoryPrototype.upsert({
    where: { category_id: categoryId },
    create: {
      category_id: categoryId,
      embedding,
      example_count: rebuilt.example_count,
      updated_at: new Date(),
    },
    update: {
      embedding,
      example_count: rebuilt.example_count,
      updated_at: new Date(),
    },
  });
  return true;
}

async function upsertCategory(item) {
  const category = await prisma.newsCategory.upsert({
    where: { code: item.code },
    create: {
      code: item.code,
      name: item.name,
      description: item.description,
      color: item.color,
      sort_order: item.sort_order,
      status: 'active',
    },
    update: {
      name: item.name,
      description: item.description,
      color: item.color,
      sort_order: item.sort_order,
      status: 'active',
      updated_at: new Date(),
    },
  });

  await prisma.newsCategoryExample.deleteMany({ where: { category_id: category.id } });
  await prisma.newsCategoryExample.createMany({
    data: item.examples.map((title) => ({
      category_id: category.id,
      title,
    })),
  });

  return category.id;
}

async function main() {
  let prototypeReady = 0;
  let prototypeSkipped = false;

  for (const item of DEFAULT_CATEGORIES) {
    const categoryId = await upsertCategory(item);
    process.stdout.write(`✓ ${item.name} (${item.code})\n`);

    try {
      const ok = await syncPrototype(categoryId, item.examples);
      if (ok) {
        prototypeReady += 1;
      }
    } catch (error) {
      if (!prototypeSkipped) {
        prototypeSkipped = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`\n⚠ ML 原型向量未生成（${message}），类别与示例标题已写入数据库`);
      }
    }
  }

  const total = DEFAULT_CATEGORIES.length;
  console.log(`\n完成：共 ${total} 个分类`);
  if (prototypeReady > 0) {
    console.log(`其中 ${prototypeReady} 个已生成冷启动原型向量`);
  } else if (prototypeSkipped) {
    console.log('启动 ML 服务后，可在管理后台编辑类别以重新生成原型向量');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
