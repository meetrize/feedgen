import { FastifyPluginAsync } from 'fastify';
import * as bcrypt from 'bcrypt';

// 从server.ts导入prisma实例
import { prisma } from '../server';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // 用户注册
  fastify.post('/register', async (req: any, res: any) => {
    try {
      const { email, username, password } = req.body as {
        email?: string;
        username?: string;
        password?: string;
      };
      const e = typeof email === 'string' ? email.trim().slice(0, 255) : '';
      const u = typeof username === 'string' ? username.trim().slice(0, 100) : '';
      const p = typeof password === 'string' ? password : '';

      if (!u) {
        return res.status(400).send({ error: '用户名不能为空' });
      }
      if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return res.status(400).send({ error: '请填写有效邮箱' });
      }
      if (!p || p.length < 6) {
        return res.status(400).send({ error: '密码至少 6 位' });
      }

      // 检查用户是否已存在
      const existingEmail = await prisma.user.findUnique({
        where: { email: e },
      });
      if (existingEmail) {
        return res.status(400).send({ error: '邮箱已被注册' });
      }
      const existingUsername = await prisma.user.findUnique({
        where: { username: u },
      });
      if (existingUsername) {
        return res.status(400).send({ error: '用户名已被占用' });
      }

      // 加密密码
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(p, saltRounds);
      
      // 创建新用户
      const newUser = await prisma.user.create({
        data: {
          email: e,
          username: u,
          password_hash: hashedPassword,
        },
      });

      // 生成JWT token
      const token = fastify.jwt.sign(
        { userId: newUser.id, email: newUser.email, is_admin: false },
        { expiresIn: '7d' }
      );

      return {
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          username: newUser.username,
          is_admin: false,
        },
      };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(400).send({ error: '用户名或邮箱已被占用' });
      }
      return res.status(500).send({ error: 'Registration failed' });
    }
  });

  // 用户登录（邮箱或用户名 + 密码）
  fastify.post('/login', async (req: any, res: any) => {
    try {
      const { email, username, password } = req.body as {
        email?: string;
        username?: string;
        password?: string;
      };

      if (!password || typeof password !== 'string') {
        return res.status(400).send({ error: '请提供密码' });
      }

      const u = typeof username === 'string' ? username.trim() : '';
      const e = typeof email === 'string' ? email.trim() : '';

      let user = null;
      if (u) {
        user = await prisma.user.findUnique({ where: { username: u } });
      } else if (e) {
        user = await prisma.user.findUnique({ where: { email: e } });
      } else {
        return res.status(400).send({ error: '请提供邮箱或用户名' });
      }

      if (!user) {
        return res.status(401).send({ error: 'Invalid credentials' });
      }

      // 验证密码
      const isValidPassword = await bcrypt.compare(password, user.password_hash);

      if (!isValidPassword) {
        return res.status(401).send({ error: 'Invalid credentials' });
      }

      // 生成JWT token
      const token = fastify.jwt.sign(
        {
          userId: user.id,
          email: user.email,
          username: user.username,
          is_admin: user.is_admin,
        },
        { expiresIn: '7d' }
      );

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          is_admin: user.is_admin,
        },
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Login failed' });
    }
  });

  // 获取当前用户信息
  fastify.get('/me', async (req: any, res: any) => {
    try {
      // 检查认证
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Authentication required' });
      }

      const token = authHeader.substring(7); // 移除 "Bearer " 前缀
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId;
      
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          is_anonymous: true,
          is_admin: true,
          created_at: true,
        },
      });

      if (!user) {
        return res.status(404).send({ error: 'User not found' });
      }

      return { user };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to fetch user info' });
    }
  });

  // 当前登录用户修改资料（用户名、邮箱、密码），并可选记录浏览器特征
  fastify.put('/profile', async (req: any, res: any) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: '需要先登录' });
      }
      const decoded: any = await req.jwtVerify();
      const userId = decoded.userId as number;
      const body = req.body as {
        username?: string;
        email?: string;
        password?: string;
        browser_fingerprint?: unknown;
      };

      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) {
        return res.status(404).send({ error: '用户不存在' });
      }

      const username =
        typeof body.username === 'string' ? body.username.trim().slice(0, 100) : existing.username;
      const email =
        typeof body.email === 'string' ? body.email.trim().slice(0, 255) : existing.email;

      if (!username) {
        return res.status(400).send({ error: '用户名不能为空' });
      }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).send({ error: '请填写有效邮箱' });
      }

      const pwd =
        typeof body.password === 'string' && body.password.length > 0 ? body.password : null;
      if (pwd !== null && pwd.length < 6) {
        return res.status(400).send({ error: '密码至少 6 位' });
      }

      // 仅当「占位邮箱 → 正式邮箱」时必须同时设密码；只改用户名或仍在 @example.com 内换邮箱时允许不设密码
      const isPlaceholderEmail = (e: string) => e.toLowerCase().endsWith('@example.com');
      const upgradingFromPlaceholder =
        existing.is_anonymous &&
        isPlaceholderEmail(existing.email) &&
        !isPlaceholderEmail(email);
      if (upgradingFromPlaceholder && !pwd) {
        return res.status(400).send({
          error: '将占位邮箱改为正式邮箱时，请同时设置密码（至少 6 位）',
        });
      }

      const data: Record<string, unknown> = {
        username,
        email,
        updated_at: new Date(),
      };

      if (pwd !== null) {
        data.password_hash = await bcrypt.hash(pwd, 10);
        data.is_anonymous = false;
      }

      if (body.browser_fingerprint !== undefined) {
        data.browser_meta =
          body.browser_fingerprint === null
            ? null
            : typeof body.browser_fingerprint === 'object'
              ? body.browser_fingerprint
              : null;
      }

      const updated = await prisma.user.update({
        where: { id: userId },
        data: data as any,
      });

      const token = fastify.jwt.sign(
        {
          userId: updated.id,
          email: updated.email,
          username: updated.username,
          is_anonymous: updated.is_anonymous,
          is_admin: updated.is_admin,
        },
        { expiresIn: '30d' }
      );

      return {
        token,
        user: {
          id: updated.id,
          username: updated.username,
          email: updated.email,
          is_anonymous: updated.is_anonymous,
          is_admin: updated.is_admin,
        },
      };
    } catch (error: any) {
      req.log.error(error);
      if (error?.code === 'P2002') {
        return res.status(400).send({ error: '用户名或邮箱已被占用' });
      }
      return res.status(500).send({ error: '更新资料失败' });
    }
  });

  // 创建匿名用户
  fastify.post('/create-anonymous', async (req: any, res: any) => {
    try {
      // 随机用户名，满足 users.username 唯一且便于展示
      const anonymousId = `anonymous_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const username = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      
      // 创建匿名用户
      const newUser = await prisma.user.create({
        data: {
          username: username, // 使用唯一用户名
          email: `${anonymousId}@example.com`, // 使用唯一邮箱
          password_hash: '', // 匿名用户无密码
          is_anonymous: true, // 标记为匿名用户
        },
      });

      // 生成JWT token
      const token = fastify.jwt.sign(
        {
          userId: newUser.id,
          email: newUser.email,
          username: newUser.username,
          is_anonymous: true,
          is_admin: false,
        },
        { expiresIn: '30d' } // 匿名用户token有效期更长
      );

      return {
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          username: newUser.username,
          is_anonymous: true,
        },
      };
    } catch (error) {
      req.log.error(error);
      return res.status(500).send({ error: 'Failed to create anonymous user' });
    }
  });
};

export { authRoutes };