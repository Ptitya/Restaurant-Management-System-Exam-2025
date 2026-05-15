// src/routes/menu.ts
import { Router, Request, Response } from 'express'
import { Category } from '@prisma/client'
import prisma from '../lib/prisma'
import { authenticate, requireRole } from '../middleware/auth'

const router = Router()

// GET /api/menu — list / search
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const search = req.query.search ? String(req.query.search) : undefined
    const category = req.query.category ? String(req.query.category) : undefined

    if (search) {
      // ✅ BUG-003: ป้องกัน SQL Injection โดยใช้ Prisma
      const results = await prisma.menuItem.findMany({
        where: {
          isAvailable: true,
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } }
          ]
        }
      })
      res.status(200).json(results)
      return
    }

    const items = await prisma.menuItem.findMany({
      where: {
        isAvailable: true,
        ...(category ? { category: category as Category } : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
    res.status(200).json(items)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// POST /api/menu — admin only
router.post('/', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as any
    const { name, price, stock } = body

    // ✅ ตรวจสอบความถูกต้องของข้อมูล (Validation)
    if (!name || price === undefined) {
      res.status(400).json({ error: 'Name and price required' })
      return
    }

    // ✅ TC-015: ป้องกันการใส่สต็อกติดลบ
    if (stock !== undefined && Number(stock) < 0) {
      res.status(400).json({ error: 'Stock cannot be negative' })
      return
    }

    const item = await prisma.menuItem.create({
      data: {
        name: body.name,
        description: body.description,
        price: Number(body.price),
        category: body.category as Category,
        imageUrl: body.imageUrl,
        // ใช้ชื่อฟิลด์ให้ตรงกับที่มีใน DB (ถ้าใน DB ไม่มี stock บรรทัดนี้จะแดง ให้ลบออกหรือใช้ any)
        ...(body.stock !== undefined ? { stock: Number(body.stock) } : {} as any)
      } as any
    })
    res.status(201).json(item)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// PUT /api/menu/:id — admin only
// ✅ BUG-004: ป้องกัน Waiter แก้ราคา (เพิ่ม requireRole('admin'))
router.put('/:id', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id)
    const body = req.body as any
    
    const item = await prisma.menuItem.findUnique({ where: { id } })
    if (!item) {
      res.status(404).json({ error: 'Menu item not found' })
      return
    }

    // ✅ TC-015: ตรวจสอบไม่ให้แก้ไขสต็อกเป็นค่าติดลบ
    if (body.stock !== undefined && Number(body.stock) < 0) {
      res.status(400).json({ error: 'Stock cannot be negative' })
      return
    }

    const updated = await prisma.menuItem.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        price: body.price !== undefined ? Number(body.price) : undefined,
        category: body.category as Category,
        isAvailable: body.isAvailable,
        imageUrl: body.imageUrl,
        ...(body.stock !== undefined ? { stock: Number(body.stock) } : {} as any)
      } as any
    })
    res.status(200).json(updated)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// DELETE /api/menu/:id
router.delete('/:id', authenticate, requireRole('admin'), async (req: Request, res: Response): Promise<void> => {
  try {
    const id = Number(req.params.id)
    const item = await prisma.menuItem.findUnique({ where: { id } })
    if (!item) {
      res.status(404).json({ error: 'Menu item not found' })
      return
    }
    await prisma.menuItem.update({ where: { id }, data: { isAvailable: false } })
    res.status(200).json({ message: 'Menu item disabled' })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router