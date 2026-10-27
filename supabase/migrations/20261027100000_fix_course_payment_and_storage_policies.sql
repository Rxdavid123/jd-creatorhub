-- Forward-only repair for installations that may have applied the earlier course migration.
DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    ALTER TABLE public.course_enrollments DROP CONSTRAINT IF EXISTS course_enrollments_payment_id_fkey;
    ALTER TABLE public.course_enrollments ADD CONSTRAINT course_enrollments_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.grant_course_enrollment(p_order_id uuid, p_student_id uuid, p_provider_payment_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_order public.orders; v_payment public.payments; v_item public.order_items; v_course public.courses; v_enrollment_id uuid;
BEGIN
  IF p_order_id IS NULL OR p_student_id IS NULL OR nullif(trim(p_provider_payment_id), '') IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status = 'cancelled' THEN RETURN NULL; END IF;
  SELECT * INTO v_payment FROM public.payments WHERE order_id = p_order_id AND provider = 'razorpay' AND provider_payment_id = p_provider_payment_id AND status = 'captured' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM public.order_items WHERE order_id = p_order_id) <> 1 THEN RETURN NULL; END IF;
  SELECT * INTO v_item FROM public.order_items WHERE order_id = p_order_id;
  IF NOT FOUND OR v_item.product_id IS NULL OR v_item.quantity <> 1 OR v_item.line_total_minor <> v_item.unit_price_minor THEN RETURN NULL; END IF;
  SELECT c.* INTO v_course FROM public.course_product_links l JOIN public.courses c ON c.id = l.course_id WHERE l.product_id = v_item.product_id AND c.status = 'published' AND c.price_minor = v_item.unit_price_minor AND c.currency = v_order.currency;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.course_enrollments(course_id, student_id, order_id, payment_id, payment_status) VALUES (v_course.id, p_student_id, p_order_id, v_payment.id, 'captured')
  ON CONFLICT (course_id, student_id) DO UPDATE SET payment_status = CASE WHEN public.course_enrollments.payment_status = 'captured' THEN public.course_enrollments.payment_status ELSE excluded.payment_status END, order_id = coalesce(public.course_enrollments.order_id, excluded.order_id), payment_id = coalesce(public.course_enrollments.payment_id, excluded.payment_id)
  RETURNING id INTO v_enrollment_id;
  RETURN v_enrollment_id;
END; $$;
REVOKE ALL ON FUNCTION public.grant_course_enrollment(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_course_enrollment(uuid, uuid, text) TO service_role;

DROP POLICY IF EXISTS course_files_owner_read ON storage.objects;
DROP POLICY IF EXISTS course_files_owner_insert ON storage.objects;
DROP POLICY IF EXISTS course_files_owner_update ON storage.objects;
DROP POLICY IF EXISTS course_files_owner_delete ON storage.objects;
CREATE POLICY course_files_declared_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'course-files' AND EXISTS (SELECT 1 FROM public.course_resources r JOIN public.course_lessons l ON l.id = r.lesson_id JOIN public.course_sections s ON s.id = l.section_id JOIN public.courses c ON c.id = s.course_id WHERE r.storage_path = name AND (c.owner_id = (SELECT auth.uid()) OR EXISTS (SELECT 1 FROM public.course_enrollments e WHERE e.course_id = c.id AND e.student_id = (SELECT auth.uid()) AND e.payment_status IN ('free','captured')))));
CREATE POLICY course_files_declared_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'course-files' AND EXISTS (SELECT 1 FROM public.course_resources r JOIN public.course_lessons l ON l.id = r.lesson_id JOIN public.course_sections s ON s.id = l.section_id JOIN public.courses c ON c.id = s.course_id WHERE r.storage_path = name AND c.owner_id = (SELECT auth.uid())));
CREATE POLICY course_files_declared_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'course-files' AND EXISTS (SELECT 1 FROM public.course_resources r JOIN public.course_lessons l ON l.id = r.lesson_id JOIN public.course_sections s ON s.id = l.section_id JOIN public.courses c ON c.id = s.course_id WHERE r.storage_path = name AND c.owner_id = (SELECT auth.uid()))) WITH CHECK (bucket_id = 'course-files' AND EXISTS (SELECT 1 FROM public.course_resources r JOIN public.course_lessons l ON l.id = r.lesson_id JOIN public.course_sections s ON s.id = l.section_id JOIN public.courses c ON c.id = s.course_id WHERE r.storage_path = name AND c.owner_id = (SELECT auth.uid())));
CREATE POLICY course_files_declared_delete ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'course-files' AND EXISTS (SELECT 1 FROM public.course_resources r JOIN public.course_lessons l ON l.id = r.lesson_id JOIN public.course_sections s ON s.id = l.section_id JOIN public.courses c ON c.id = s.course_id WHERE r.storage_path = name AND c.owner_id = (SELECT auth.uid())));
